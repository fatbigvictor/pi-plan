# pi-plan

Hard-stop plan mode for [pi](https://github.com/earendil-works/pi). Read-only while planning, the
plan is a file that outlives the session, and **nothing executes until a human approves**.

```bash
pi install git:github.com/fatbigvictor/pi-plan
```

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
| `bash` read-only | allowlist — no `rm`, `mv`, `git commit`, `npm install`, editors |
| the plan is a file | `write_plan` is the only write channel, and only writes `docs/plans/YYYY-MM-DD_<slug>.md` |
| nothing runs early | `edit`/`write` return only from `approve()` — `/plan go`, or the dialog |
| edits stay in scope | after approval, edits outside the plan's declared `files` are blocked |

The last two are the point. An extension that restores its own tools is not a gate, and an approval
that names no files is a mood rather than a set.

## The asymmetry

> The agent may **enter** plan mode (`request_plan_mode`, or you type `/plan`).
> Only the human may **leave** it (`/plan go`).

So asking for a plan in plain words works, and approval is never something the agent can do for
itself.

## Commands

```text
/plan                 toggle plan mode
/plan on | off        explicit
/plan go              approve the written plan and start executing
/plan allow <path>    approve one extra path (when reality differs from the plan)
/plan status          mode, plan file, approved files, step progress
/todos                step checklist
Ctrl+Alt+P            toggle
pi --plan             start in plan mode
```

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
marks completion. The `plan` skill holds the full convention — one verification line per step, the
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
gate (`/plan go`), approved-file-set enforcement, and `request_plan_mode`.

## Licence

MIT.
