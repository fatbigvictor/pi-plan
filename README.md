# pi-plan

Hard-stop plan mode for [pi](https://github.com/earendil-works/pi). Read-only while planning, the
plan is a file that outlives the session, and **nothing executes until a human approves**.

```bash
pi install git:github.com/fatbigvictor/pi-plan
```

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
`write_plan` **refuses until it has been used**: two to four questions whose answers would change the
plan — scope, inputs, what "done" means, the constraint you were about to assume. Each question
carries a `why`, shown as `asked because: …`: the step, file, or verification line its answer
changes. No justification, no question. Mid-way, when a fork appears whose branches differ
materially, the agent is told to ask again instead of picking one quietly. Answer with an option, or
type your own; one Escape stops the round.

## Why this exists

Coding agents "plan" by talking. The plan lives in the transcript, dies with the session, and gives
you no guarantee that the agent will not simply start editing while it is still describing what it
would do. Two mechanisms fix that, and they are different mechanisms:

- **enforcement** — the write tools are *not available*, so the agent cannot edit whether or not it
  wants to. This needs an extension; a prompt can only ask politely.
- **an artifact** — the plan is a file in the repo, so a later session, a reviewer, or you in a
  week can read what was decided and why.

This package ships both: the `plan` extension for the first, the `plan` skill for the second.

## What it enforces

| while planning | by |
|---|---|
| `edit` / `write` unusable | removed from the active tool set **and** blocked in the `tool_call` interceptor |
| `bash` read-only by default | every segment's executable must be on the read-only allowlist; no `rm`, `mv`, `git commit`, `npm install`, editors, redirection, or substitution |
| anything else is a question — or not, in allow-all | `tool_call` interceptor; the human picks the mode |
| the plan is written from answers | `write_plan` refuses until `ask_user` has been used, and every question must name what its answer changes |
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
The `plan` skill holds the full convention — one verification line per step, the
status lifecycle, and how a later session resumes.

## Layout

```text
extensions/plan/    the extension (index.ts + utils.ts — both required)
skills/plan/        the document convention
```

The extension imports only `node:fs`, `node:path`, and type/class references that pi resolves to
its own copies (`pi-coding-agent`, `pi-tui`, `typebox`). There is nothing to `npm install`; the two
`.ts` files must ship together because `utils.ts` is imported relatively.

## Attribution

`extensions/plan/utils.ts` and the shape of the read-only tool set come from pi's own
`examples/extensions/plan-mode`. What is added here: the `write_plan` artifact tool, the approval
gate (`/plan go`), approved-file-set enforcement, `request_plan_mode`, the `ask_user` interview and
its gate, the two approval modes, and `/plan exit`.

## Licence

MIT.
