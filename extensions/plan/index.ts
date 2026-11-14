/**
 * Plan mode — hard-stop planning with a durable artifact.
 *
 * Based on pi's `examples/extensions/plan-mode`, extended in four directions.
 *
 * 1. ENFORCEMENT. While planning, `edit` and `write` are not active tools, and `bash` runs only
 *    commands the read-only allowlist recognises. What happens to the rest depends on the approval
 *    mode: `manual` (the default) puts every unrecognised command to the human — run once, trust the
 *    executable for the session, or block — and `allow-all` runs it without asking. Either way the
 *    write tools stay off; allow-all is about investigation not being interrupted, not about the
 *    gate. Only the human switches modes.
 *
 * 2. THE ARTIFACT. `write_plan` is the only way to write a file in plan mode, and it can only write
 *    `docs/plans/YYYY-MM-DD_<slug>.md`. So the plan outlives the session, and the write channel is
 *    one file wide. The filename and the frontmatter are the tool's job, never the model's memory.
 *
 * 3. THE INTERVIEW. A plan written from assumptions is fiction in a confident voice, so `ask_user`
 *    exists and `write_plan` refuses until it has been used: two to four questions whose answers
 *    would change the plan, asked before the investigation, and again when a fork appears.
 *
 * THE GATE. Nothing executes until a human approves: `/plan go`, or the dialog that appears after a
 * plan is written. Both call `approve()`, and `approve()` is the only code path that restores
 * `edit`/`write`. An extension that restores its own tools is not a gate, it is a log line.
 * `/plan exit` is the other human exit: keep the plan file, run nothing, continue in a new session.
 *
 * AFTER APPROVAL the plan's declared file list is enforced: `edit`/`write` to a path the plan does
 * not name is blocked, and `/plan allow <path>` extends the set deliberately. The plan document
 * itself is always writable — it is the progress ledger.
 *
 * Commands: /plan [on|off|go|exit|allow-all|manual|allow <path>|trust <command>|status] · /todos · Ctrl+Alt+P
 */

import * as fs from "node:fs";
import * as path from "node:path";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, TextContent } from "@earendil-works/pi-ai";
import {
	type ExtensionAPI,
	type ExtensionContext,
	isToolCallEventType,
} from "@earendil-works/pi-coding-agent";
import { Key } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { type TodoItem, explainUnsafe, exeNames, isApprovedTarget, markCompletedSteps } from "./utils.ts";

const WRITE_PLAN_TOOL = "write_plan";
const ASK_TOOL = "ask_user";
const PLAN_MODE_TOOLS = ["read", "bash", "grep", "find", "ls", WRITE_PLAN_TOOL, ASK_TOOL];
const REQUEST_TOOL = "request_plan_mode";
const NORMAL_MODE_TOOLS = ["read", "bash", "edit", "write", REQUEST_TOOL, ASK_TOOL];
const PLAN_MODE_DISABLED_TOOLS = new Set<string>(["edit", "write"]);
const PLAN_MANAGED_TOOLS = new Set<string>([...PLAN_MODE_TOOLS, ...NORMAL_MODE_TOOLS]);

const PLANS_DIR = path.join("docs", "plans");
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * How an unrecognised bash command is treated while planning.
 *
 * `manual` asks the human; `allow-all` does not. The write tools are off in both, so this is a
 * dial on interruption, not on the gate — and only the human turns it.
 */
type ApprovalMode = "manual" | "allow-all";

interface PlanModeState {
	enabled: boolean;
	executing: boolean;
	todos: TodoItem[];
	planPath?: string;
	files: string[];
	awaitingApproval?: boolean;
	approval?: ApprovalMode;
	approvalChosen?: boolean;
	interviewed?: boolean;
	toolsBeforePlanMode?: string[];
	/** Executables the human allowed by hand this session (see the plan-mode bash prompt). */
	sessionAllowed?: string[];
}

function isAssistantMessage(m: AgentMessage): m is AssistantMessage {
	return m.role === "assistant" && Array.isArray(m.content);
}

function getTextContent(message: AssistantMessage): string {
	return message.content
		.filter((block): block is TextContent => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

/** Numbered steps under a `## Steps` heading, owned by the plan document rather than by prose. */
function extractSteps(doc: string): TodoItem[] {
	const items: TodoItem[] = [];
	const m = doc.match(/^##\s*Steps\s*$/im);
	if (!m || m.index === undefined) return items;
	const section = doc.slice(m.index + m[0].length);
	for (const line of section.split("\n")) {
		if (/^##\s/.test(line)) break;
		const step = line.match(/^\s*(\d+)[.)]\s+(.+?)\s*$/);
		if (!step) continue;
		const text = step[2].replace(/\*\*/g, "").trim();
		if (text.length > 3) items.push({ step: items.length + 1, text: text.slice(0, 120), completed: false });
	}
	return items;
}

/** Local date, not UTC: a plan written at 01:00 HKT belongs to that day. */
function today(): string {
	const d = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cwdOf(ctx: unknown): string {
	const c = ctx as { cwd?: string } | undefined;
	return c?.cwd ?? process.cwd();
}

export default function planExtension(pi: ExtensionAPI): void {
	let enabled = false;
	let executing = false;
	let todos: TodoItem[] = [];
	let planPath: string | undefined;
	let files: string[] = [];
	let awaitingApproval = false;
	let approval: ApprovalMode = "manual";
	let approvalChosen = false;
	let interviewed = false;
	let toolsBeforePlanMode: string[] | undefined;
	let sessionAllowed: string[] = [];

	pi.registerFlag("plan", {
		description: "Start in plan mode (read-only, plans to docs/plans/)",
		type: "boolean",
		default: false,
	});

	function updateStatus(ctx: ExtensionContext): void {
		if (executing && todos.length > 0) {
			const done = todos.filter((t) => t.completed).length;
			ctx.ui.setStatus("plan-mode", ctx.ui.theme.fg("accent", `📋 ${done}/${todos.length}`));
			ctx.ui.setWidget(
				"plan-todos",
				todos.map((t) =>
					t.completed
						? ctx.ui.theme.fg("success", "☑ ") + ctx.ui.theme.fg("muted", ctx.ui.theme.strikethrough(t.text))
						: `${ctx.ui.theme.fg("muted", "☐ ")}${t.text}`,
				),
			);
		} else if (enabled) {
			const trusted = sessionAllowed.length > 0 ? ` +${sessionAllowed.length}` : "";
			const gate = approval === "allow-all" ? " · allow all" : "";
			ctx.ui.setStatus(
				"plan-mode",
				ctx.ui.theme.fg("warning", (awaitingApproval ? "⏸ plan — awaiting /plan go" : "⏸ plan") + gate + trusted),
			);
			ctx.ui.setWidget("plan-todos", undefined);
		} else {
			ctx.ui.setStatus("plan-mode", undefined);
			ctx.ui.setWidget("plan-todos", undefined);
		}
	}

	function unique(names: string[]): string[] {
		return [...new Set(names)];
	}

	function enablePlanTools(): void {
		if (toolsBeforePlanMode === undefined) toolsBeforePlanMode = pi.getActiveTools();
		pi.setActiveTools(
			unique([...toolsBeforePlanMode.filter((n) => !PLAN_MODE_DISABLED_TOOLS.has(n)), ...PLAN_MODE_TOOLS]),
		);
	}

	function restoreNormalTools(): void {
		pi.setActiveTools(
			toolsBeforePlanMode ?? unique([...NORMAL_MODE_TOOLS, ...pi.getActiveTools().filter((n) => !PLAN_MANAGED_TOOLS.has(n))]),
		);
		toolsBeforePlanMode = undefined;
	}

	function persist(): void {
		pi.appendEntry("plan-mode", {
			enabled,
			executing,
			todos,
			planPath,
			files,
			awaitingApproval,
			approval,
			approvalChosen,
			interviewed,
			toolsBeforePlanMode,
			sessionAllowed,
		} satisfies PlanModeState);
	}

	function enterPlanMode(ctx: ExtensionContext): void {
		enabled = true;
		executing = false;
		awaitingApproval = false;
		interviewed = false;
		sessionAllowed = [];
		enablePlanTools();
		updateStatus(ctx);
		persist();
	}

	/**
	 * The one question at the start of planning that saves ten later: how should bash be handled?
	 *
	 * Asked only when the model opened the gate (the human typing `/plan` does not need to be asked
	 * what they meant), and only once per session — after that `/plan allow-all` and `/plan manual`
	 * are the switches. Escape keeps whatever mode is current.
	 */
	async function promptApprovalMode(ctx: ExtensionContext): Promise<void> {
		if (!ctx.hasUI || approvalChosen) return;
		const manual = "Manual — a command outside the read-only set asks me first";
		const allow = "Allow all — investigate freely, no command prompts (edit/write stay blocked)";
		const choice = await ctx.ui.select("Plan mode: how should bash be handled while planning?", [
			approval === "allow-all" ? allow : manual,
			approval === "allow-all" ? manual : allow,
		]);
		if (!choice) return;
		approval = choice.startsWith("Allow") ? "allow-all" : "manual";
		approvalChosen = true;
		persist();
		updateStatus(ctx);
	}

	function leavePlanMode(ctx: ExtensionContext, note = "Plan mode off. Full access restored."): void {
		enabled = false;
		executing = false;
		awaitingApproval = false;
		sessionAllowed = [];
		restoreNormalTools();
		ctx.ui.notify(note, "info");
		updateStatus(ctx);
		persist();
	}

	/**
	 * The human's third exit: keep the plan, execute nothing, and hand the work to another session.
	 *
	 * Deliberately not the same as approving. The plan stays `draft`, `executing` stays false, so no
	 * progress tracking and no file-list enforcement follow the agent into normal mode. The user gets
	 * the one line they need to start the work elsewhere; this session is done with it.
	 */
	function exitPlanMode(ctx: ExtensionContext): void {
		if (!planPath) {
			ctx.ui.notify("No plan yet — nothing to save. Use /plan off to leave plan mode.", "warning");
			return;
		}
		const rel = planPath.split(path.sep).join("/");
		enabled = false;
		executing = false;
		awaitingApproval = false;
		sessionAllowed = [];
		restoreNormalTools();
		updateStatus(ctx);
		persist();
		ctx.ui.notify(
			`Plan saved: ${rel} — nothing was executed, status stays draft.\n` +
				`Start a new session and say: execute ${rel}\n` +
				`(This session has full access again; the plan's file list is not enforced here.)`,
			"info",
		);
	}

	/** The only path that restores write access. Reached from `/plan go` or the dialog, never on its own. */
	function approve(ctx: ExtensionContext): void {
		if (!planPath) {
			ctx.ui.notify("No plan yet. Ask for a plan first — it writes docs/plans/<date>_<slug>.md.", "warning");
			return;
		}
		enabled = false;
		executing = true;
		awaitingApproval = false;
		sessionAllowed = []; // the step-up list was for planning; execution has full access
		restoreNormalTools();
		updateStatus(ctx);
		persist();

		const remaining = todos.filter((t) => !t.completed).map((t) => `${t.step}. ${t.text}`).join("\n");
		pi.sendMessage(
			{
				customType: "plan-mode-execute",
				content: `Execute the plan in \`${planPath}\`.

Approved files (edits outside this list are blocked — ask the user to \`/plan allow <path>\`):
${files.map((f) => `- ${f}`).join("\n") || "- (none declared; any edit will be blocked)"}

The plan document itself is always writable: \`${planPath}\` — tick steps there and set \`status: in_progress\`.

Remaining steps:
${remaining || "(none extracted — follow the document)"}

Update the plan's status to \`in_progress\` and tick steps as you go. After finishing a step, include [DONE:n].`,
				display: true,
			},
			{ triggerTurn: true, deliverAs: "followUp" },
		);
	}

	// ── the artifact ────────────────────────────────────────────────────────────────────────────
	pi.registerTool({
		name: WRITE_PLAN_TOOL,
		label: "Write plan",
		description:
			"Write the implementation plan to docs/plans/<YYYY-MM-DD>_<slug>.md. The only file that can be " +
			"written in plan mode. Call it once, when the plan is complete, then stop: it writes the file " +
			"and waits for the user to approve with /plan go. Pass every file the plan will edit in " +
			"`files` — after approval those are the only paths that may be touched.",
		parameters: Type.Object({
			slug: Type.String({ description: "kebab-case topic, e.g. activities-endpoint" }),
			content: Type.String({ description: "The plan body in markdown, starting with context, then ## Steps" }),
			files: Type.Array(Type.String(), {
				description: "Repo-relative paths this plan will edit. Enforced after approval.",
			}),
			supersedes: Type.Optional(
				Type.String({ description: "Filename of the plan this replaces, e.g. 2026-11-09_app-build.md" }),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const slug = String(params.slug ?? "").trim();
			const body = String(params.content ?? "").trim();
			const declared = (params.files ?? []).map((f: string) => String(f).trim()).filter(Boolean);

			// A plan written from assumptions is fiction in a confident voice. The interview is part of
			// the deliverable, so the tool refuses without it rather than trusting the prompt to remind.
			if (!interviewed && ctx.hasUI) {
				return {
					content: [
						{
							type: "text",
							text:
								"No interview yet. Call `ask_user` with the two to four questions whose answers would change " +
								"this plan (scope, inputs, what \"done\" means, the constraint you were about to assume), then " +
								"write the plan with those answers in it.",
						},
					],
					details: {},
					isError: true,
				};
			}

			if (!SLUG_RE.test(slug)) {
				return {
					content: [{ type: "text", text: `\`slug\` must be kebab-case (a-z0-9, hyphens): got ${JSON.stringify(slug)}` }],
					details: {},
					isError: true,
				};
			}
			if (body.length < 80) {
				return {
					content: [{ type: "text", text: "Refusing to write a plan under 80 characters — that is a wish, not a plan." }],
					details: {},
					isError: true,
				};
			}
			if (!/^##\s*Steps\s*$/im.test(body)) {
				// Steps drive the progress widget and the resume path; a plan without them cannot be executed.
				return {
					content: [{ type: "text", text: "The plan needs a `## Steps` section with a numbered list." }],
					details: {},
					isError: true,
				};
			}
			const steps = extractSteps(body);
			if (steps.length === 0) {
				// A heading with no parseable steps leaves the progress widget, [DONE:n], and the
				// completion check with nothing to work on — the plan would run blind.
				return {
					content: [
						{
							type: "text",
							text:
								"`## Steps` has no numbered steps. Use `1. **step** — ...` lines directly under the heading " +
								"(not `-` bullets, not a subheading): they drive the progress widget and [DONE:n].",
						},
					],
					details: {},
					isError: true,
				};
			}

			const root = cwdOf(ctx);
			const dir = path.join(root, PLANS_DIR);
			const file = path.join(dir, `${today()}_${slug}.md`);
			if (fs.existsSync(file)) {
				return {
					content: [
						{
							type: "text",
							text: `${PLANS_DIR}/${today()}_${slug}.md already exists. A written plan is frozen: pick a new slug, or pass supersedes and a new slug.`,
						},
					],
					details: {},
					isError: true,
				};
			}

			const supersedes = params.supersedes ? String(params.supersedes).trim() : "";
			const front = [
				"---",
				`title: ${slug.replace(/-/g, " ")}`,
				`created: ${today()}`,
				"status: draft",
				...(supersedes ? [`supersedes: ${supersedes}`] : []),
				"files:",
				...(declared.length ? declared.map((f) => `  - ${f}`) : ["  []"]),
				"---",
				"",
			].join("\n");

			fs.mkdirSync(dir, { recursive: true });
			fs.writeFileSync(file, `${front}\n${body}\n`, { encoding: "utf8" });

			planPath = path.join(PLANS_DIR, `${today()}_${slug}.md`);
			files = declared;
			todos = steps;
			awaitingApproval = true;
			persist();

			const rel = planPath.split(path.sep).join("/");
			return {
				content: [
					{
						type: "text",
						text:
							`Wrote ${rel} (${declared.length} file(s) declared, ${todos.length} step(s)).\n\n` +
							"PLAN MODE STAYS ON. Stop here and summarise the plan in two lines; do not start work. " +
							"The user approves with /plan go, or saves it with /plan exit to run it in another session.",
					},
				],
				details: { path: rel, files: declared, steps: todos.length },
			};
		},
	});

	// ── the interview ──────────────────────────────────────────────────────────────────────────
	// A plan is a conversation before it is a document: the model cannot ask four useful questions
	// in prose and get four usable answers out of one reply. Each question here is a decision point
	// the human answers on the spot, and the answers land in the transcript where the plan can quote
	// them. Available in and out of plan mode — asking is never the risky part.
	pi.registerTool({
		name: ASK_TOOL,
		label: "Ask user",
		description:
			"Ask the human one to six questions and wait for the answers. Call this before writing a plan — " +
			"the questions whose answers would change the plan — and again when a fork appears mid-plan, " +
			"instead of guessing. Every question must carry a `why`: the step, file, or verification line its " +
			"answer changes. If you cannot name one, the question does not belong in the interview. Options are " +
			"suggestions: the human can always write their own answer.",
		executionMode: "sequential",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "One question, in one sentence" }),
					header: Type.Optional(Type.String({ description: "Short label, e.g. 'Data source'" })),
					why: Type.String({
						description:
							"What the answer changes: the step, the file list, or the verification line. Shown to the " +
							"user as 'asked because: …'.",
					}),
					options: Type.Optional(
						Type.Array(Type.String(), { description: "Suggested answers. Omit for a free-text question." }),
					),
				}),
				{ minItems: 1, maxItems: 6 },
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const questions = (params.questions ?? []) as {
				question: string;
				header?: string;
				why?: string;
				options?: string[];
			}[];
			if (questions.length === 0) {
				return { content: [{ type: "text", text: "No questions to ask." }], details: {}, isError: true };
			}

			// The justification is the criterion made visible. Validate all of them before asking any, so a bad
			// third question does not cost the first two answers.
			for (let i = 0; i < questions.length; i++) {
				const text = String(questions[i].question ?? "").trim();
				const why = String(questions[i].why ?? "").trim();
				if (!text || why) continue;
				return {
					content: [
						{
							type: "text",
							text:
								`Question ${i + 1} ("${text}") has no \`why\`. Name the step, file, or verification line the answer ` +
								"would change — if you cannot name one, drop the question rather than asking it. Nothing was " +
								"asked yet.",
						},
					],
					details: {},
					isError: true,
				};
			}

			if (!ctx.hasUI) {
				// Headless: nothing can be asked, so do not let the artefact gate deadlock.
				interviewed = true;
				persist();
				return {
					content: [{ type: "text", text: "No UI to put a dialog in — ask these in prose, then plan." }],
					details: { asked: questions.length },
					isError: true,
				};
			}

			const answers: string[] = [];
			let cancelled = false;
			for (const q of questions) {
				const text = String(q.question ?? "").trim();
				if (!text) continue;
				const why = String(q.why ?? "").trim();
				const label = q.header ? `${q.header}: ${text}` : text;
				const options = (q.options ?? []).map((o) => String(o).trim()).filter(Boolean);
				const title = [q.header, text, "", `asked because: ${why}`].filter((line) => line !== undefined).join("\n");

				let answer: string | undefined;
				if (options.length === 0) {
					answer = await ctx.ui.input(title);
				} else {
					const own = "Other — I'll type it";
					const choice = await ctx.ui.select(title, [...options, own]);
					answer = choice === own ? await ctx.ui.input(title) : choice;
				}

				if (!answer || !answer.trim()) {
					cancelled = true;
					answers.push(`${label}\n  asked because: ${why}\n  → (cancelled — the questions stopped here)`);
					break;
				}
				answers.push(`${label}\n  asked because: ${why}\n  → ${answer.trim()}`);
			}

			if (answers.length > 0) {
				interviewed = true;
				persist();
			}

			return {
				content: [
					{
						type: "text",
						text:
							`Answers:\n${answers.join("\n")}\n\n` +
							(cancelled
								? "The user stopped the questions. Plan with what you have and put what is still unknown under Open questions; do not ask again in this turn."
								: "Neither invent answers nor ask again: write the plan now, with these answers in it, and let them show in the plan's Context."),
					},
				],
				details: { asked: questions.length, answered: answers.length },
			};
		},
	});

	// The model may ENTER the gate; only the human may leave it. That asymmetry is what lets
	// "plan how to X" work without typing /plan, while keeping approval out of reach.
	pi.registerTool({
		name: REQUEST_TOOL,
		label: "Request plan mode",
		description:
			"Switch to read-only plan mode. Call this FIRST, before any investigation, when the user asks for a " +
			"plan, an approach, or how to build something. edit/write are then unavailable, so you must investigate " +
			"and then call write_plan and stop. Only the user can leave plan mode (/plan go).",
		parameters: Type.Object({
			reason: Type.Optional(Type.String({ description: "One line: what is being planned" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			if (executing) {
				return {
					content: [
						{ type: "text", text: "A plan is already approved and executing. Ask the user to /plan off before planning again." },
					],
					details: {},
					isError: true,
				};
			}
			if (enabled) {
				return { content: [{ type: "text", text: "Already in plan mode — investigate, then write_plan, then stop." }], details: {} };
			}
			enterPlanMode(ctx);
			await promptApprovalMode(ctx);
			return {
				content: [
					{
						type: "text",
						text:
							`Plan mode on${params.reason ? ` (${params.reason})` : ""}. Read-only: edit and write are gone` +
							(approval === "allow-all" ? ", and bash runs without asking" : ", and bash runs read-only commands without asking") +
							`.\n\nFIRST: call \`${ASK_TOOL}\` with the two to four questions whose answers would change the plan, ` +
							"each with a `why` naming the step, file, or verification line it changes. Then read AGENTS.md and " +
							"the files that will change, write the plan with the document convention from the `plan` skill, and " +
							"stop. (write_plan refuses until you have asked.)",
					},
				],
				details: { enabled: true, approval },
			};
		},
	});

	// ── commands ────────────────────────────────────────────────────────────────────────────────
	pi.registerCommand("plan", {
		description:
			"Plan mode: on | off | go | exit | allow-all | manual | allow <path> | trust <command> | status (no argument toggles)",
		handler: async (args, ctx) => {
			const [sub, ...rest] = (args ?? "").trim().split(/\s+/).filter(Boolean);
			const arg = rest.join(" ");
			switch (sub) {
				case "go":
				case "approve":
					return approve(ctx);
				case "exit":
				case "save":
					return exitPlanMode(ctx);
				case "on":
					return enabled ? ctx.ui.notify("Already in plan mode.", "info") : enterPlanMode(ctx);
				case "off":
					return enabled ? leavePlanMode(ctx) : ctx.ui.notify("Not in plan mode.", "info");
				case "allow-all":
				case "all": {
					approval = "allow-all";
					approvalChosen = true;
					persist();
					updateStatus(ctx);
					return ctx.ui.notify(
						"Allow-all: while planning, bash no longer asks (edit/write still blocked, /plan go still gates execution).",
						"info",
					);
				}
				case "manual": {
					approval = "manual";
					approvalChosen = true;
					persist();
					updateStatus(ctx);
					return ctx.ui.notify("Manual approval: a command outside the read-only allowlist asks you first.", "info");
				}
				case "allow": {
					if (!arg) return ctx.ui.notify("Usage: /plan allow <path>", "warning");
					files = unique([...files, arg.split(path.sep).join("/")]);
					persist();
					ctx.ui.notify(`Approved path added: ${arg}`, "info");
					return;
				}
				case "trust": {
					if (!arg) {
						return ctx.ui.notify(
							`Allowed by hand this session: ${sessionAllowed.length ? sessionAllowed.join(", ") : "none"}`,
							"info",
						);
					}
					sessionAllowed = unique([...sessionAllowed, arg.trim()]);
					persist();
					updateStatus(ctx);
					return ctx.ui.notify(`${arg.trim()} may now run in plan mode this session`, "info");
				}
				case "status": {
					const lines = [
						`mode: ${enabled ? "plan (read-only)" : executing ? "executing" : "normal"}`,
						`approval: ${approval}${enabled ? "" : " (applies while planning)"}`,
						`interview: ${interviewed ? "asked" : "not asked yet (write_plan will refuse)"}`,
						`plan: ${planPath ?? "none"}`,
						`files: ${files.length ? files.join(", ") : "none declared"}`,
						`steps: ${todos.filter((t) => t.completed).length}/${todos.length} done`,
						`trusted: ${sessionAllowed.length ? sessionAllowed.join(", ") : "none (every step-up asks)"}`,
					];
					return ctx.ui.notify(lines.join("\n"), "info");
				}
				default:
					if (enabled) leavePlanMode(ctx);
					else enterPlanMode(ctx);
			}
		},
	});

	pi.registerCommand("todos", {
		description: "Show the current plan's step progress",
		handler: async (_args, ctx) => {
			if (todos.length === 0) return ctx.ui.notify("No steps yet. Ask for a plan first.", "info");
			ctx.ui.notify(
				`Plan progress (${planPath ?? "no file"}):\n` +
					todos.map((t, i) => `${i + 1}. ${t.completed ? "✓" : "○"} ${t.text}`).join("\n"),
				"info",
			);
		},
	});

	pi.registerShortcut(Key.ctrlAlt("p"), {
		description: "Toggle plan mode",
		handler: async (ctx) => (enabled ? leavePlanMode(ctx) : enterPlanMode(ctx)),
	});

	// ── enforcement ─────────────────────────────────────────────────────────────────────────────
	pi.on("tool_call", async (event, ctx) => {
		// 1. Planning: bash is read-only by default, and a human may step it up for one command.
		//    The gate is human judgement, so a research command the allowlist does not recognise is a
		//    question, not a dead end. Without a UI there is nobody to ask, so it stays blocked.
		//    In allow-all mode the question is skipped; the write tools stay off either way.
		if (enabled && event.toolName === "bash") {
			const command = String(event.input.command ?? "");
			const why = explainUnsafe(command);
			if (why && approval === "manual") {
				const names = exeNames(command);
				const trusted = names.length > 0 && names.every((n) => sessionAllowed.includes(n));
				if (!trusted) {
					if (!ctx.hasUI) {
						return { block: true, reason: `Plan mode: ${why}. No UI available to approve an exception.` };
					}
					const trustLabel = names.length ? `Allow ${names.join(", ")} for this session` : undefined;
					const choice = await ctx.ui.select(
						`Plan mode — this command is not read-only\n\n${command}\n\nReason: ${why}`,
						["Run this once", ...(trustLabel ? [trustLabel] : []), "Block"],
					);
					if (!choice || choice === "Block") {
						return {
							block: true,
							reason: `Plan mode: blocked by the user (${why}). Investigate with read/rg/find instead of retrying.`,
						};
					}
					if (trustLabel && choice === trustLabel) {
						sessionAllowed = unique([...sessionAllowed, ...names]);
						persist();
						updateStatus(ctx);
					}
				}
			}
		}

		// 2. Planning: the write tools are gone, but enforce anyway if one is somehow active.
		if (enabled && (event.toolName === "edit" || event.toolName === "write")) {
			return {
				block: true,
				reason: `Plan mode: ${event.toolName} is disabled. Write the plan with ${WRITE_PLAN_TOOL}; the user approves with /plan go.`,
			};
		}

		// 3. Executing: only the paths the approved plan declared — plus the plan document itself,
		//    which is the progress ledger and must stay writable or the run cannot tick its steps.
		if (executing && (isToolCallEventType("write", event) || isToolCallEventType("edit", event))) {
			const target = String(event.input.path ?? "");
			if (!target) return;
			const root = cwdOf(ctx);
			if (isApprovedTarget(root, target, files, planPath)) return;
			if (files.length === 0) {
				return {
					block: true,
					reason: "The approved plan declared no files. Ask the user to /plan allow <path> before editing.",
				};
			}
			return {
				block: true,
				reason:
					`${target} is not in the approved plan (${files.join(", ")}; the plan document ${planPath} is ` +
					"always writable). Either add it to the plan and get it approved, or ask the user to /plan allow " +
					target,
			};
		}
	});

	// Stale plan context must not leak into a normal session.
	pi.on("context", async (event) => {
		if (enabled || executing) return;
		return {
			messages: event.messages.filter((m) => {
				const msg = m as AgentMessage & { customType?: string };
				if (msg.customType === "plan-mode-context") return false;
				if (msg.role !== "user") return true;
				const content = msg.content;
				if (typeof content === "string") return !content.includes("[PLAN MODE ACTIVE]");
				if (Array.isArray(content)) {
					return !content.some((c) => c.type === "text" && (c as TextContent).text?.includes("[PLAN MODE ACTIVE]"));
				}
				return true;
			}),
		};
	});

	pi.on("before_agent_start", async (event) => {
		if (event.messageType !== "user") return;

		if (enabled) {
			const bashPolicy =
				approval === "allow-all"
					? "\nBash runs without asking this session: run whatever investigation you need. The write tools stay off.\n"
					: [
						"",
						"Bash runs read-only commands without asking. If a command you need is outside that set — a test",
						"run, a script, a build — run it anyway: the human is asked whether to allow it, and their",
						"answer is the policy. A refusal means 'find another way', not 'try a variant of the same command'.",
						"",
					].join("\n");
			return {
				message: {
					customType: "plan-mode-context",
					content: `[PLAN MODE ACTIVE — read-only${approval === "allow-all" ? ", allow-all" : ", manual approval"}]

You are planning, not building. \`edit\` and \`write\` are not available.

INTERVIEW FIRST. Before you investigate deeply, call \`${ASK_TOOL}\` with the two to four questions whose
answers would actually change the plan — scope, the inputs, what "done" means, the constraint you
were about to assume. **Each question needs a \`why\`**: the step, file, or verification line its
answer changes, which the user sees as "asked because: …". If you cannot name one, drop the question.
Reading a file or two first to make the questions concrete is fine; planning on
an unasked assumption is not. ${WRITE_PLAN_TOOL} refuses until you have asked, which is deliberate.
${bashPolicy}
Do this, in order:
1. Interview (\`${ASK_TOOL}\`), then read the project's AGENTS.md and the files that will change.
   State your assumptions explicitly — one you write down is a question someone can answer.
2. If a fork appears whose branches differ materially, ask again rather than picking one quietly.
3. Write the plan with the \`${WRITE_PLAN_TOOL}\` tool. The \`plan\` skill holds the document convention;
   the tool enforces what it can (ISO-dated filename, frontmatter, numbered \`## Steps\`).
   Pass every file you intend to edit in \`files\`; after approval those are the only paths you may touch.
4. Then STOP. Two lines of summary, no work.

Do not begin implementing. The user approves with /plan go, or saves the plan with /plan exit to run
it in a different session.`,
					display: false,
				},
			};
		}

		if (executing && todos.length > 0) {
			const remaining = todos.filter((t) => !t.completed).map((t) => `${t.step}. ${t.text}`).join("\n");
			return {
				message: {
					customType: "plan-execution-context",
					content: `[EXECUTING PLAN — access to the approved files only]\n\nPlan: ${planPath}\n\nRemaining steps:\n${remaining}\n\nExecute in order. After each step include [DONE:n]. Stay inside the approved files; the plan document itself (${planPath}) is always writable, so tick steps and set \`status: in_progress\` there. If a step turns out to be wrong or a fork appears mid-way, call ${ASK_TOOL} rather than diverging quietly.`,
					display: false,
				},
			};
		}
	});

	pi.on("turn_end", async (event, ctx) => {
		if (!executing || todos.length === 0) return;
		if (!isAssistantMessage(event.message)) return;
		if (markCompletedSteps(getTextContent(event.message), todos) > 0) updateStatus(ctx);
		persist();
	});

	pi.on("agent_end", async (event, ctx) => {
		if (executing && todos.length > 0 && todos.every((t) => t.completed)) {
			pi.sendMessage(
				{ customType: "plan-complete", content: `**Plan complete** ✓\n\n${todos.map((t) => `~~${t.text}~~`).join("\n")}`, display: true },
				{ triggerTurn: false },
			);
			executing = false;
			todos = [];
			updateStatus(ctx);
			persist();
			return;
		}

		// The gate's other door: after a plan is written, offer approval. Same function as /plan go.
		if (!enabled || !awaitingApproval || !ctx.hasUI) return;
		const choice = await ctx.ui.select("Plan written. What next?", [
			"Approve and execute (/plan go)",
			"Save and exit — implement it in a new session (/plan exit)",
			"Refine the plan",
			"Stay in plan mode",
		]);
		if (choice?.startsWith("Approve")) approve(ctx);
		else if (choice?.startsWith("Save and exit")) exitPlanMode(ctx);
		else if (choice === "Refine the plan") {
			const refinement = await ctx.ui.editor("Refine the plan:", "");
			if (refinement?.trim()) pi.sendUserMessage(refinement.trim(), { deliverAs: "followUp" });
		}
	});

	pi.on("session_start", async (_event, ctx) => {
		if (pi.getFlag("plan") === true) enabled = true;

		const entries = ctx.sessionManager.getEntries();
		const last = entries
			.filter((e: { type: string; customType?: string }) => e.type === "custom" && e.customType === "plan-mode")
			.pop() as { data?: PlanModeState } | undefined;

		if (last?.data) {
			enabled = last.data.enabled ?? enabled;
			executing = last.data.executing ?? false;
			todos = last.data.todos ?? [];
			planPath = last.data.planPath;
			files = last.data.files ?? [];
			awaitingApproval = last.data.awaitingApproval ?? false;
			approval = last.data.approval ?? "manual";
			approvalChosen = last.data.approvalChosen ?? false;
			interviewed = last.data.interviewed ?? false;
			toolsBeforePlanMode = last.data.toolsBeforePlanMode;
			sessionAllowed = last.data.sessionAllowed ?? [];
		}

		// On resume mid-execution, rebuild progress from the transcript after the execute marker.
		if (last && executing && todos.length > 0) {
			let start = -1;
			for (let i = entries.length - 1; i >= 0; i--) {
				if ((entries[i] as { customType?: string }).customType === "plan-mode-execute") {
					start = i;
					break;
				}
			}
			const text = entries
				.slice(start + 1)
				.map((e) => (e.type === "message" && "message" in e ? e.message : undefined))
				.filter((m): m is AgentMessage => Boolean(m) && isAssistantMessage(m as AgentMessage))
				.map((m) => getTextContent(m as AssistantMessage))
				.join("\n");
			markCompletedSteps(text, todos);
		}

		if (enabled) enablePlanTools();
		updateStatus(ctx);
	});
}
