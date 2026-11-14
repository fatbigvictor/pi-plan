# Plan mode

Hard-stop planning for pi. Vendored from pi's `examples/extensions/plan-mode` and extended so the
plan is a **file**, the questions are **asked**, and the gate is **enforced**.

## What it enforces

| while planning | mechanism |
|---|---|
| `edit` / `write` unusable | removed from the active tool set (`setActiveTools`) **and** blocked in the `tool_call` interceptor |
| `bash` read-only by default | `utils.ts: explainUnsafe` — the line is split into segments and every segment's executable must be read-only; redirection, substitution, and heredocs are refused outright |
| anything else asks the human — or does not, in allow-all | `tool_call` interceptor; the human picks the mode when planning starts |
| the plan is written from answers | `write_plan` refuses until `ask_user` has been used, and every question must name what its answer changes |
| the plan is a file | `write_plan` is the only write channel, and it can only write `docs/plans/YYYY-MM-DD_<slug>.md` |
| nothing executes early | `edit`/`write` come back only from `approve()` — `/plan go` or the dialog |
| edits stay in scope | after approval, `edit`/`write` are blocked outside the plan's declared `files`, except the plan document itself |

The last two matter most. An extension that restores its own tools is not a gate, and an approval
that names no files is a mood rather than a set. The plan document is deliberately exempt from the
file set: it is the progress ledger, and needing `/plan allow docs/plans/<the plan>` to tick its own
steps stalled a real run (`utils.ts: isApprovedTarget`).

The allowlist is per segment, not per line: `rg "code" src/` is research and `ls && sed -i s/a/b/ f`
is a write. Checking the whole line with one blocklist got both of those wrong — the first was blocked
by the word "code", the second passed because it began with `ls`. `utils.test.ts` holds the cases.

## Approval modes

| mode | non-read-only bash while planning |
|---|---|
| `manual` (default) | a dialog: run once · trust the executable for the session · block |
| `allow-all` | runs, no dialog |

`edit`/`write` stay off in both, and `/plan go` still gates execution. When the model opens plan mode
(`request_plan_mode`) it asks this once as a dialog and the answer sticks for the session;
`/plan allow-all` and `/plan manual` change it after that. The mode is persisted with the session.

## The interview

`ask_user` takes one to six questions, each with optional suggested answers (the human can always
type their own) and a **required `why`** — the step, file, or verification line the answer changes,
shown in the dialog as `asked because: …`. A question that cannot name one is refused, because a plan
written from assumptions is fiction in a confident voice. The prompt asks for two to four questions
up front — scope, inputs, what "done" means, the constraint about to be assumed — and again mid-plan
when a fork would change the design.

## Commands

```text
/plan                        toggle plan mode
/plan on | off               explicit
/plan go                     approve the written plan and start executing
/plan exit                   keep the plan, execute nothing — run it in another session
/plan allow-all              planning: bash never asks (edit/write stay blocked)
/plan manual                 planning: a non-read-only command asks first (default)
/plan allow <path>           approve one extra path (when reality differs from the plan)
/plan trust <command>        stop asking about one executable this session (no argument: list them)
/plan status                 mode, approval mode, interview, plan file, approved files, steps, trusted
/todos                       step checklist
Ctrl+Alt+P                   toggle
```

`pi --plan` starts in plan mode. `pi -e ~/.pi/agent/extensions/plan/index.ts` loads it for one run.

## The artifact

`docs/plans/2026-11-10_activities-endpoint.md`, written by the `write_plan` tool:

```markdown
---
title: activities endpoint
created: 2026-11-10
status: draft
files:
  - backend/main.py
  - frontend/src/lib/api.ts
---

<context>
## Steps
1. ...
## Risks
## Open questions
```

The filename and the frontmatter are the tool's job — never the model's memory. A plan that already
exists is **frozen**: a revision is a new file with `supersedes:`. `## Steps` drives the progress
widget and `[DONE:n]` marks completion.

## Notes

- Lives outside any git repo (`~/.pi/agent/`). If this is worth keeping, move it into a dotfiles
  repo and symlink, or `pi install` from that source.
- `docs/plans/` is created on first use. It is a document directory on purpose: `plan/` collides
  with things that are already called plans in other repos (Terraform, billing, npm packages).
