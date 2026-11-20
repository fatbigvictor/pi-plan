# pi-plan

A unified delivery workflow for [pi](https://github.com/earendil-works/pi), backed by hard-stop
plan mode. Read-only while planning, the plan is a file that outlives the session, and **nothing
executes until a human approves**.

```bash
pi install git:github.com/fatbigvictor/pi-plan
```

## The deliver workflow

Every implementation request is triaged the way a programmer would take it on: **study** the
scope, **classify** and announce it, **interview** what is undecided, **summarise** the shared
understanding, then let a **risk test** pick the artefact before **executing**. Two independent
dials drive it — *uncertainty* (how many decision forks are open) sets the question budget, in
grilling style with a recommended answer for each; *risk* (irreversible or expensive to undo,
must outlive the chat, costly wrong guess, file list not yet nameable) decides between working
directly, an inline mini-plan confirmed in chat, and a formal plan under the gate below. Small
clear tasks short-circuit straight to work; decision-only grilling ("grill me", "stress-test
this") ends at the shared understanding with nothing built. The `deliver` skill holds the full
workflow; the rest of this README is the enforcement it stands on when the risk test fires.

## Planning is investigative

A planner that cannot run one command plans from fiction. Plan mode therefore denies quietly only
what is certainly read-only — reading, searching, `git log|diff|show`, `npm ls`, `curl`, and the
like — and handles everything else according to the **approval mode**:

| mode | a command outside the read-only set |
|---|---|
| `manual` (default) | asks you: run once, trust the executable for the session, or block |
| `allow-all` | runs it, no dialog |

The agent cannot grant itself either mode. When the **model** opens plan mode it asks you once —
*manual* or *allow all* — and the answer sticks for the session; `/plan allow-all` and `/plan manual`
change it at any time. The write tools stay off in both: allow-all is a dial on interruption, not on
the gate.

## The interview comes before the plan

A plan written from assumptions is fiction in a confident voice, so the `ask_user` tool exists and
`write_plan` **refuses until an interview is usable**: the questions whose answers would change the
plan — scope, inputs, what "done" means, the constraint you were about to assume. Each question
carries a `why`, shown as `asked because: …`: the step, file, or verification line its answer
changes. No justification, no question. The interview normally happens during triage, before plan
mode is even entered, and it **carries in**: entering plan mode does not discard it, a successful
`write_plan` consumes it, and leaving the gate (`/plan go`, `/plan exit`, plan mode off) clears it,
so one task's answers can never satisfy another task's plan. Mid-way, when a fork appears whose
branches differ materially, the agent is told to ask again instead of picking one quietly. Answer
with an option, or type your own; one Escape stops the round.

## Why this exists

Coding agents "plan" by talking. The plan lives in the transcript, dies with the session, and gives
you no guarantee that the agent will not simply start editing while it is still describing what it
would do. Two mechanisms fix that, and they are different mechanisms:

- **enforcement** — the write tools are *not available*, so the agent cannot edit whether or not it
  wants to. This needs an extension; a prompt can only ask politely.
- **an artifact** — the plan is a file in the repo, so a later session, a reviewer, or you in a
  week can read what was decided and why.

This package ships both: the `plan` extension for the first, and the `deliver` skill for the
second — the workflow that decides, per request, which of the two a task actually needs.

## What it enforces

| while planning | by |
|---|---|
| `edit` / `write` unusable | removed from the active tool set **and** blocked in the `tool_call` interceptor |
| `bash` read-only by default | every segment's executable must be on the read-only allowlist; no `rm`, `mv`, `git commit`, `npm install`, editors, redirection, or substitution |
| anything else is a question — or not, in allow-all | `tool_call` interceptor; the human picks the mode |
| the plan is written from answers | `write_plan` refuses until an interview is usable (asked in plan mode, or carried unconsumed from earlier in the session), and every question must name what its answer changes |
| the plan is a file | `write_plan` is the only write channel, and only writes `docs/plans/YYYY-MM-DD_<slug>.md` |
| nothing runs early | `edit`/`write` return only from `approve()` — `/plan go`, or the dialog |
| edits stay in scope | after approval, edits outside the plan's declared `files` are blocked; the plan document itself is always writable |

The last two are the point. An extension that restores its own tools is not a gate, and an approval
that names no files is a mood rather than a set. The plan document is the exception to the file set
on purpose: it is the progress ledger, so ticking a step must never require an approval round.

## The asymmetry

> The agent may **enter** plan mode (`request_plan_mode`, or you type `/plan`).
> Only the human may **leave** it (`/plan go`).

So asking for a plan in plain words works, and approval is never something the agent can do for
itself.

## Commands

```text
/plan                        toggle plan mode
/plan on | off               explicit
/plan go                     approve the written plan and start executing
/plan exit                   keep the plan file, execute nothing — run it in a new session
/plan allow-all              planning: bash never asks (edit/write stay blocked)
/plan manual                 planning: a non-read-only command asks first (default)
/plan allow <path>           approve one extra path (when reality differs from the plan)
/plan trust <command>        stop asking about one executable this session (no argument: list them)
/plan status                 mode, approval mode, interview, plan file, approved files, steps, trusted commands
/todos                       step checklist
Ctrl+Alt+P                   toggle
pi --plan                    start in plan mode
```

The dialog after a plan is written offers the same choices: **approve and execute**, **save and exit**
(the plan stays `draft`, this session runs nothing, and the next session picks it up from the file),
**refine**, or **stay**.

## The artifact

```markdown
---
title: activities endpoint
created: 2026-11-10
status: draft
files:
  - backend/main.py
---

## Context
## Steps
1. **<imperative step>** — *Verify:* `<a command or measurable outcome>`
## Risks
## Open questions
```

Filename and frontmatter are the tool's job, never the model's memory. A written plan is **frozen**:
a revision is a new file with `supersedes:`. `## Steps` drives the progress widget; `[DONE:n]`
marks completion. While the plan is current the document is mutable — that is how steps get ticked
and `status:` moves — and it is writable without being declared in `files:`.
The `deliver` skill holds the full convention — one verification line per step, the
status lifecycle, and how a later session resumes. (Before 0.3.0 this was the `plan` skill;
`/skill:plan` references should now use `/skill:deliver`.)

## Layout

```text
extensions/plan/    the extension (index.ts + utils.ts — both required)
skills/deliver/     the unified workflow: triage, interview, risk test, document convention
```

The extension imports only `node:fs`, `node:path`, and type/class references that pi resolves to
its own copies (`pi-coding-agent`, `pi-tui`, `typebox`). There is nothing to `npm install`; the two
`.ts` files must ship together because `utils.ts` is imported relatively.

## Attribution

`extensions/plan/utils.ts` and the shape of the read-only tool set come from pi's own
`examples/extensions/plan-mode`. What is added here: the `write_plan` artifact tool, the approval
gate (`/plan go`), approved-file-set enforcement, `request_plan_mode`, the `ask_user` interview and
its gate (including interview carry-over from triage), the two approval modes, and `/plan exit`.

## Licence

MIT.
