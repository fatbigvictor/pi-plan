/**
 * Pure utility functions for plan mode.
 * Extracted for testability — see utils.test.ts.
 */

import * as path from "node:path";

/**
 * Plan mode's read-only gate.
 *
 * A command is split into simple-command segments at the shell operators that can start a new
 * command, and EVERY segment's executable must be a known read-only one. The earlier version
 * matched the whole line against one blocklist and one start-anchored allowlist, which failed in
 * both directions: `rg "code" src/` was blocked because the *word* "code" tripped the editor rule,
 * while `ls && sed -i s/a/b/ file` passed because `^\s*ls` matched the first token. Checking each
 * segment's executable fixes the false positives and the bypass together.
 *
 * Commands that are not clearly read-only are not silently refused by the agent — the extension
 * asks the human, who may allow them once or trust the executable for the session.
 */

export interface ParsedCommand {
	/** One entry per simple command: `a && b` yields two. */
	segments: string[][];
	/** Unquoted constructs that can run code or write a file, found anywhere in the line. */
	hazards: string[];
}

const SEGMENT_BREAKS = new Set([";", "&", "|", "\n"]);

/** Index just past the `)` matching the `(` at `open`, ignoring parentheses inside quotes. */
function skipParens(command: string, open: number): number {
	let depth = 0;
	let quote: string | undefined;
	for (let i = open; i < command.length; i++) {
		const ch = command[i];
		if (quote) {
			if (ch === quote) quote = undefined;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "(") depth++;
		else if (ch === ")" && --depth === 0) return i + 1;
	}
	return command.length;
}

/** Split a shell line into simple commands, honouring quotes. Not a full shell parser — just enough. */
export function parseCommand(command: string): ParsedCommand {
	const segments: string[][] = [];
	const hazards: string[] = [];
	let argv: string[] = [];
	let token = "";
	let hasToken = false;
	let i = 0;

	const endToken = () => {
		if (hasToken) {
			argv.push(token);
			token = "";
			hasToken = false;
		}
	};
	const endSegment = () => {
		endToken();
		if (argv.length > 0) segments.push(argv);
		argv = [];
	};
	const add = (ch: string) => {
		token += ch;
		hasToken = true;
	};

	while (i < command.length) {
		const ch = command[i];

		if (ch === "'") {
			const end = command.indexOf("'", i + 1);
			if (end === -1) {
				hazards.push("unterminated single quote");
				break;
			}
			for (let k = i + 1; k < end; k++) add(command[k]);
			hasToken = true;
			i = end + 1;
			continue;
		}

		if (ch === '"') {
			let k = i + 1;
			let closed = false;
			while (k < command.length) {
				const c = command[k];
				if (c === "\\" && k + 1 < command.length) {
					add(command[k + 1]);
					k += 2;
					continue;
				}
				if (c === '"') {
					closed = true;
					break;
				}
				if (c === "`") hazards.push("command substitution");
				if (c === "$" && command[k + 1] === "(") hazards.push("command substitution");
				add(c);
				k++;
			}
			if (!closed) {
				hazards.push("unterminated double quote");
				break;
			}
			hasToken = true;
			i = k + 1;
			continue;
		}

		if (ch === "\\" && i + 1 < command.length) {
			add(command[i + 1]);
			i += 2;
			continue;
		}
		if (ch === "`") {
			hazards.push("command substitution");
			i++;
			continue;
		}
		if (ch === "$" && command[i + 1] === "(") {
			hazards.push("command substitution");
			i = skipParens(command, i + 1);
			continue;
		}
		if ((ch === "<" || ch === ">") && command[i + 1] === "(") {
			hazards.push("process substitution");
			i = skipParens(command, i + 1);
			continue;
		}
		if (ch === "#" && !hasToken) {
			const nl = command.indexOf("\n", i);
			if (nl === -1) break;
			i = nl;
			continue;
		}
		if (ch === ">") {
			// fd duplication (`2>&1`, `>&-`) writes no file
			const dup = /^>&(?:\d+|-)/.exec(command.slice(i));
			if (dup) {
				i += dup[0].length;
				continue;
			}
			hazards.push("output redirection");
			i++;
			continue;
		}
		if (ch === "<") {
			if (command[i + 1] === "<") {
				hazards.push("heredoc");
				i += 2;
				continue;
			}
			i++; // plain input redirection only reads a file
			continue;
		}
		if (ch === "(" || ch === ")") {
			hazards.push("subshell");
			i++;
			continue;
		}
		if (SEGMENT_BREAKS.has(ch)) {
			endSegment();
			i++;
			continue;
		}
		if (ch === " " || ch === "\t" || ch === "\r") {
			endToken();
			i++;
			continue;
		}
		add(ch);
		i++;
	}

	endSegment();
	return { segments, hazards: [...new Set(hazards)] };
}

function resolveExe(word: string | undefined): string | undefined {
	if (!word) return undefined;
	const base = word.split(/[\\/]/).pop() ?? word;
	return base.toLowerCase().replace(/\.(exe|cmd|bat|com)$/, "");
}

/** The executables a line would run, in order. Used to offer "trust this for the session". */
export function exeNames(command: string): string[] {
	const names: string[] = [];
	for (const argv of parseCommand(command).segments) {
		const name = resolveExe(argv[0]);
		if (name && !names.includes(name)) names.push(name);
	}
	return names;
}

/** Commands whose subcommand or flags need no inspection: nothing past the hazards can write. */
const PLAIN_READ_ONLY = new Set([
	"cat", "head", "tail", "less", "more", "wc", "uniq", "comm", "cut", "tr", "nl", "paste", "join",
	"rev", "cmp", "sdiff", "diff", "file", "stat", "du", "df", "which", "whereis", "type", "printenv",
	"uname", "whoami", "id", "date", "cal", "uptime", "ps", "top", "htop", "free", "ls", "pwd",
	"echo", "printf", "grep", "egrep", "fgrep", "jq", "base64", "md5sum", "sha1sum", "sha256sum",
	"xxd", "od", "strings", "numfmt", "expr", "basename", "dirname", "realpath", "readlink",
	"getconf", "locale", "nproc", "tty", "arch", "seq", "column", "sleep", "true", "false",
]);

type Guard = (argv: string[]) => string | undefined;

const GIT_READ_ONLY = new Set([
	"status", "log", "diff", "show", "blame", "shortlog", "describe", "rev-parse", "rev-list",
	"ls-files", "ls-tree", "ls-remote", "show-ref", "show-branch", "name-rev", "cat-file",
	"for-each-ref", "merge-base", "whatchanged", "reflog", "check-ignore", "check-attr",
	"count-objects", "cherry", "diff-tree", "diff-index", "diff-files", "range-diff", "verify-pack",
]);

const GIT_SUBCOMMAND_GUARDS: Record<string, Guard> = {
	branch: (rest) =>
		rest.some((a) => /^(-[dDmMf]|--delete|--move|--force|--set-upstream|-u|--edit-description|--track)$/.test(a))
			? "git branch can delete, move, or retarget refs"
			: undefined,
	remote: (rest) =>
		rest.some((a) => /^(add|remove|rm|rename|set-url|set-head|prune|update)$/.test(a))
			? "git remote can change the remote configuration"
			: undefined,
	tag: (rest) =>
		rest.some((a) => /^(-[adsmfu]|--delete|--force|--annotate|--sign|--message|--file)$/.test(a))
			? "git tag can create or delete tags"
			: undefined,
	config: (rest) =>
		/^(--get|--get-all|--get-regexp|--list|-l)$/.test(rest[0] ?? "")
			? undefined
			: "git config writes unless it is a --get or --list",
	stash: (rest) => (rest[0] === "list" || rest[0] === "show" ? undefined : "git stash can mutate the stash"),
	submodule: (rest) => (rest[0] === "status" || rest[0] === "summary" ? undefined : "git submodule can change the tree"),
	worktree: (rest) => (rest[0] === "list" ? undefined : "git worktree can change checkouts"),
	notes: (rest) => (rest[0] === "list" || rest[0] === "show" ? undefined : "git notes can write"),
	"sparse-checkout": (rest) => (rest[0] === "list" ? undefined : "git sparse-checkout can change the tree"),
	bisect: (rest) => (rest[0] === "log" ? undefined : "git bisect can move HEAD"),
};

const guardGit: Guard = (argv) => {
	const args = argv.slice(1);
	let i = 0;
	while (i < args.length && args[i].startsWith("-")) {
		const a = args[i];
		if (a === "-C") {
			i += 2;
			continue;
		}
		// -c/--config-env can run an arbitrary pager or alias: `git -c core.pager=rm ... log`
		if (a === "--no-pager" || a === "--no-optional-locks" || a === "--literal-pathspecs" || a === "-p") {
			i += 1;
			continue;
		}
		return `git ${a} is not on the plan-mode allowlist`;
	}
	const sub = args[i];
	if (!sub) return undefined;
	const known = GIT_READ_ONLY.has(sub);
	if (known) return undefined;
	const guard = GIT_SUBCOMMAND_GUARDS[sub];
	if (guard) return guard(args.slice(i + 1));
	return `git ${sub} is not a read-only git subcommand`;
};

const NPM_READ_ONLY = new Set([
	"list", "ls", "la", "ll", "view", "info", "show", "search", "outdated", "audit", "fund", "why",
	"root", "prefix", "help", "doctor", "ping", "explain", "repo",
]);

const guardNpm: Guard = (argv) => {
	const sub = argv.slice(1).find((a) => !a.startsWith("-"));
	if (!sub) return undefined; // `npm --version`
	if (sub === "version") return "npm version rewrites package.json";
	return NPM_READ_ONLY.has(sub) ? undefined : `npm ${sub} can install packages or run scripts`;
};

const GH_READ_ONLY: Record<string, Set<string>> = {
	pr: new Set(["view", "list", "diff", "checks", "status"]),
	issue: new Set(["view", "list", "status"]),
	repo: new Set(["view", "list"]),
	run: new Set(["list", "view"]),
	release: new Set(["list", "view"]),
	workflow: new Set(["list", "view"]),
	search: new Set(["code", "commits", "issues", "prs", "repos"]),
	auth: new Set(["status"]),
	status: new Set([]),
};

const guardGh: Guard = (argv) => {
	const args = argv.slice(1);
	const group = args.find((a) => !a.startsWith("-"));
	if (!group) return undefined;
	if (group === "api") {
		if (args.some((a) => /^(-X|--method|-f|--field|-F|--raw-field|--input)$/.test(a))) {
			return "gh api can send a write request";
		}
		return undefined;
	}
	const allowed = GH_READ_ONLY[group];
	if (!allowed) return `gh ${group} is not on the plan-mode allowlist`;
	if (group === "status") return undefined;
	const verb = args.slice(args.indexOf(group) + 1).find((a) => !a.startsWith("-"));
	if (!verb) return `gh ${group} needs a read-only verb`;
	return allowed.has(verb) ? undefined : `gh ${group} ${verb} is not read-only`;
};

const guardFind: Guard = (argv) => {
	const bad = argv.slice(1).find((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(a));
	return bad ? `find ${bad} modifies files` : undefined;
};

const guardAwk: Guard = (argv) => {
	// -F'|' is a field separator, not a pipe: skip flags when looking at the program text
	const bad = argv
		.slice(1)
		.filter((a) => !a.startsWith("-"))
		.find((a) => /system\s*\(|[>|]/.test(a));
	return bad ? `this awk program can run a command or write a file: ${bad}` : undefined;
};

const guardSort: Guard = (argv) => (argv.slice(1).some((a) => a === "-o" || a.startsWith("--output")) ? "sort -o writes a file" : undefined);

const guardTree: Guard = (argv) => (argv.slice(1).some((a) => a === "-o" || a.startsWith("--output")) ? "tree -o writes a file" : undefined);

const guardCurl: Guard = (argv) => {
	const writeFlags = /^(-o|-O|-T|-d|-F|-X|-c|-D|-K|--output|--remote-name|--upload-file|--data|--data-raw|--data-binary|--form|--request|--cookie-jar|--dump-header|--config|--trace|--trace-ascii|--post-data|--post-file)$/;
	return argv.slice(1).some((a) => writeFlags.test(a)) ? "this curl invocation writes a file or sends a body" : undefined;
};

const guardWget: Guard = (argv) => {
	const args = argv.slice(1);
	const stdoutOnly = args.some((a) => a === "-O-" || a === "-qO-");
	if (!stdoutOnly) return "wget writes files unless it is -O -";
	return args.some((a) => /^--post-(data|file)$/.test(a)) ? "wget --post sends a body" : undefined;
};

const guardSqlite3: Guard = (argv) => {
	const sql = argv.slice(1).join(" ");
	return /\b(insert|update|delete|drop|create|alter|attach|detach|replace|vacuum|reindex)\b/i.test(sql) ||
		/\bpragma\b[^;]*=/i.test(sql)
		? "this sqlite3 statement writes"
		: undefined;
};

const guardEnv: Guard = (argv) => {
	// `env FOO=1 cmd` runs cmd; bare `env`, `env -0`, and `env -u NAME` only print
	const args = argv.slice(1);
	return args.some((a) => !a.startsWith("-") && !/^[A-Za-z_][A-Za-z0-9_]*=/.test(a))
		? "env with a command argument runs that command"
		: undefined;
};

const versionOnly: Guard = (argv) => {
	const args = argv.slice(1);
	return args.every((a) => /^(-v|-V|--version|-h|--help)$/.test(a))
		? undefined
		: "only --version and --help are read-only here";
};

const guardRg: Guard = (argv) => (argv.slice(1).some((a) => a === "--pre" || a.startsWith("--pre=")) ? "rg --pre runs a command" : undefined);

const guardFd: Guard = (argv) =>
	argv.slice(1).some((a) => ["-x", "--exec", "-X", "--exec-batch"].includes(a)) ? "fd -x runs a command" : undefined;

const GUARDED: Record<string, Guard> = {
	git: guardGit,
	npm: guardNpm,
	gh: guardGh,
	find: guardFind,
	awk: guardAwk,
	sort: guardSort,
	tree: guardTree,
	curl: guardCurl,
	wget: guardWget,
	sqlite3: guardSqlite3,
	env: guardEnv,
	rg: guardRg,
	fd: guardFd,
	node: versionOnly,
	python: versionOnly,
	python3: versionOnly,
	py: versionOnly,
};

/**
 * Why a command is not obviously read-only, or `undefined` when it is.
 *
 * `undefined` means "safe to run without asking". Anything else is a sentence for the human,
 * who decides whether to allow it. The gate is human judgement, not a hard wall.
 */
export function explainUnsafe(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return "empty command";

	const { segments, hazards } = parseCommand(trimmed);
	if (hazards.length > 0) return `it contains ${hazards[0]}`;
	if (segments.length === 0) return "could not parse a command";

	for (const argv of segments) {
		const exe = resolveExe(argv[0]);
		if (!exe) return "could not parse a command";
		const guard = GUARDED[exe];
		if (guard) {
			const why = guard(argv);
			if (why) return why;
			continue;
		}
		if (!PLAIN_READ_ONLY.has(exe)) {
			return `\`${exe}\` is not on the read-only allowlist`;
		}
	}
	return undefined;
}

export function isSafeCommand(command: string): boolean {
	return explainUnsafe(command) === undefined;
}

/**
 * Whether an `edit`/`write` target is inside the approved plan.
 *
 * The plan document itself is always allowed. It is the progress ledger — ticking a step and
 * setting `status: in_progress` is what the document is for — and making the agent stop and ask
 * `/plan allow docs/plans/<the plan>` to update its own plan was a papercut that stalled a real
 * run. Declared files and the plan document, nothing else.
 */
export function isApprovedTarget(root: string, target: string, approved: string[], planPath?: string): boolean {
	const abs = path.resolve(root, target);
	if (planPath && path.resolve(root, planPath) === abs) return true;
	return approved.some((f) => path.resolve(root, f) === abs);
}

export interface TodoItem {
	step: number;
	text: string;
	completed: boolean;
}

export function cleanStepText(text: string): string {
	let cleaned = text
		.replace(/\*{1,2}([^*]+)\*{1,2}/g, "$1") // Remove bold/italic
		.replace(/`([^`]+)`/g, "$1") // Remove code
		.replace(
			/^(Use|Run|Execute|Create|Write|Read|Check|Verify|Update|Modify|Add|Remove|Delete|Install)\s+(the\s+)?/i,
			"",
		)
		.replace(/\s+/g, " ")
		.trim();

	if (cleaned.length > 0) {
		cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
	}
	if (cleaned.length > 50) {
		cleaned = `${cleaned.slice(0, 47)}...`;
	}
	return cleaned;
}

export function extractTodoItems(message: string): TodoItem[] {
	const items: TodoItem[] = [];
	const headerMatch = message.match(/\*{0,2}Plan:\*{0,2}\s*\n/i);
	if (!headerMatch) return items;

	const planSection = message.slice(message.indexOf(headerMatch[0]) + headerMatch[0].length);
	const numberedPattern = /^\s*(\d+)[.)]\s+\*{0,2}([^*\n]+)/gm;

	for (const match of planSection.matchAll(numberedPattern)) {
		const text = match[2]
			.trim()
			.replace(/\*{1,2}$/, "")
			.trim();
		if (text.length > 5 && !text.startsWith("`") && !text.startsWith("/") && !text.startsWith("-")) {
			const cleaned = cleanStepText(text);
			if (cleaned.length > 3) {
				items.push({ step: items.length + 1, text: cleaned, completed: false });
			}
		}
	}
	return items;
}

export function extractDoneSteps(message: string): number[] {
	const steps: number[] = [];
	for (const match of message.matchAll(/\[DONE:(\d+)\]/gi)) {
		const step = Number(match[1]);
		if (Number.isFinite(step)) steps.push(step);
	}
	return steps;
}

export function markCompletedSteps(text: string, items: TodoItem[]): number {
	const doneSteps = extractDoneSteps(text);
	for (const step of doneSteps) {
		const item = items.find((t) => t.step === step);
		if (item) item.completed = true;
	}
	return doneSteps.length;
}
