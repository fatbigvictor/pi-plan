# Plan mode

Hard-stop planning for pi. Vendored from pi's `examples/extensions/plan-mode` and extended so the
plan is a **file** and the gate is **enforced**.

## What it enforces

| while planning | mechanism |
|---|---|
| `edit` / `write` unusable | removed from the active tool set (`setActiveTools`) **and** blocked in the `tool_call` interceptor |
| `bash` read-only | allowlist (`utils.ts: isSafeCommand`) — no `rm`, `mv`, `git commit`, `npm install`, editors |
| the plan is a file | `write_plan` is the only write channel, and it can only write `docs/plans/YYYY-MM-DD_<slug>.md` |
| nothing executes early | `edit`/`write` come back only from `approve()` — `/plan go` or the dialog |
| edits stay in scope | after approval, `edit`/`write` are blocked outside the plan's declared `files` |

The last two matter most. An extension that restores its own tools is not a gate, and an approval
that names no files is a mood rather than a set.

## Commands

```text
/plan                 toggle plan mode
/plan on | off        explicit
/plan go              approve the written plan and start executing
/plan allow <path>    approve one extra path (when reality differs from the plan)
/plan status          mode, plan file, approved files, step progress
/todos                step checklist
Ctrl+Alt+P            toggle
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
