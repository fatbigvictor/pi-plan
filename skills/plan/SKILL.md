---
name: plan
description: >-
  Write an implementation plan for a change to code — how we will build it, in what order, and how
  each step is proved. Use whenever someone asks "plan how to…", "how should we build X", "write a
  plan", "what's the approach for", or asks for a plan before touching a non-trivial change. The
  plan is a file in docs/plans/ that outlives the session, and nothing is implemented until it is
  approved. NOT for training or coaching plans (those belong to the run workspace's weekly-review
  and next-run skills), not for a to-do list, and not for a one-line change.
---

# Implementation plans

A plan answers three questions: **what is wrong, what will change, and how will we know each step
worked.** Everything else is decoration.

## The mechanism, not the manners

In pi this runs under the `plan` extension (installed as `git:github.com/fatbigvictor/pi-plan`), which
enforces the parts that a prompt cannot:

| while planning | enforced by |
|---|---|
| `edit` / `write` are not available | tool set |
| `bash` is read-only by default | per-segment allowlist |
| a command it does not know | you ask the human — they answer, not you (allow-all mode skips the question) |
| the plan is written from answers | `write_plan` refuses until `ask_user` has been used |
| the plan is a file in `docs/plans/` | `write_plan` is the only write channel |
| nothing executes before approval | the tool set is restored only by `/plan go` |
| edits stay inside the plan's file list | `tool_call` interceptor, except the plan document itself |

Investigating is part of planning. Reading, searching, `git log|diff|show`, and `npm ls` just run.
For anything else — a test, a build, a scratch script — try it: the human is asked whether to allow
it. A refusal means the plan does not need that command, so plan around it. Do not retry a refused
command in a new shape.

So: **write the plan with the `write_plan` tool, then stop.** Do not start implementing, and do not
describe what you "would" do instead of writing the file — the file is the deliverable.

## Ask first

The plan is a conversation before it is a document. Start with `ask_user`, before the investigation:
**two to four questions whose answers would change the plan**, not a checklist of everything you
could know.

**Every question carries a `why`**, and the user sees it as `asked because: …`. The `why` is the test
made visible: name the step, the file in `files:`, or the verification line the answer changes. If you
cannot name one, drop the question — the tool refuses to ask it for you.

- good: *what is the input — the broker, a CSV, a daily download?* — because: it decides
  `vcp/providers.py` and what step 3 can verify.
- good: *when it disagrees with the spec, which wins?* — because: it decides the *Verify:* line on
  every filtering step, and the order they run in.
- bad: *should I write tests?* — no `why` survives: the answer is already in AGENTS.md.
- bad: *do you want it good?* — this changes no step, so there is nothing to write under
  `asked because:`.

You may read a file or two first to make the questions concrete. `write_plan` refuses until you have
asked, so "the user already told me everything" means you ask what the request leaves open — scope,
inputs, what done means, the constraint you were about to assume. Put the answers in the plan's
Context; they are the part a later reader cannot reconstruct.

Mid-way, if a fork appears whose branches differ materially, ask again with `ask_user` rather than
picking one quietly. One interview at the start and one or two questions later is the shape; a
question per file is a conversation you should be having in prose instead.

## When it fires

Say yes to: *"plan how to add X"*, *"what's the approach for migrating Y"*, *"write a plan"*,
*"how should we build this"* — anything where the change touches more than one file, or where a
wrong guess costs real work.

Say no to: a one-line change, a question ("why is this test red?"), a review, or an explanation. If
the work is small enough that the plan is longer than the diff, just do the work. **Plan mode is a
signal, not an inference** — if it is on, plan; if it is not, don't perform planning theatre.

**If plan mode is off and the work needs a plan, call `request_plan_mode` first** — that tool puts
the session into read-only mode. The asymmetry is deliberate: the agent may *enter* the gate, only
the human may *leave* it (`/plan go`, `/plan exit`, `/plan off`). So never "write the plan anyway" with the normal write
tools; that produces a document with no gate behind it.

## The document

`write_plan` decides the path and the frontmatter; you supply the body.

```markdown
---
title: activities endpoint
created: 2026-11-10
status: draft
supersedes: 2026-11-09_app-build.md     # only when replacing an earlier plan
files:                                   # you pass these to write_plan; they are enforced
  - backend/main.py
  - frontend/src/lib/api.ts
---

# <what this plan does>

## Context
Two or three sentences: what exists now, what is wrong with it, what this plan produces. Name the
files you read to find out. State assumptions explicitly — an assumption you write down is a
question someone can answer; one you keep is a bug waiting.

## Steps
1. **<imperative step>** — <the change, in one or two sentences>.
   *Verify:* `<a command, a test, or a measurable outcome>`
2. …

## Risks
What can break, what is hard to undo, and how to get back. If nothing can break, say so and move on.

## Open questions
Anything unresolved that a human should decide. Delete the section if there is nothing.
```

### One verification line per step

This is the whole difference between a plan and a wish list:

- bad: `2. Add the endpoint to the backend.`
- good: `2. **Add `GET /api/activities`** to backend/main.py, returning the archive ⋈ journal join.
  *Verify:* `curl -s localhost:8000/api/activities | jq length` equals the FIT count.`

A step whose check is "it works" is not a step. If you cannot name a check, the step is not ready to
be planned — that is a finding, so put it under Open questions instead of inventing confidence.

## The lifecycle

`status:` is `draft → approved → in_progress → done | abandoned | superseded`.

- The plan is **mutable while current**: tick steps, add a line when a step turns out to be wrong.
  That is not drift, that is the document doing its job. The plan document is always writable during
  execution — it does not have to be listed in `files:`.
- A written plan is **frozen once superseded**. A revision is a *new* file with `supersedes:`,
  never an edit of the old one — otherwise the old file silently changes meaning.
- When the work lands, set `status: done` in the same commit. A plan left at `in_progress` after
  the code shipped is a lie with a filename.

`write_plan` refuses to overwrite an existing file. That is deliberate: two plans with one name is
two sources of truth.

## Two ways to leave plan mode

Both are the human's choice, offered in the dialog after the plan is written:

- **`/plan go`** — approve and execute here. The tool set is restored, the plan's `files:` become the
  allowed paths, and `[DONE:n]` drives the progress widget.
- **`/plan exit`** — keep the file, execute nothing. The plan stays `draft` and the next session
  picks it up. Nothing about this session is a guarantee for that one, so the plan must be readable
  by someone who was not here.

Never simulate either. An agent that starts editing after writing a plan because "the user seemed
finished" has not understood the mechanism.

## Resuming

A later session picks up from the file, not from memory:

1. `ls -t docs/plans/ | head -3`, open the newest with `status: in_progress` or `draft`.
2. `git log --oneline` since the plan's `created` date — work may already be done.
3. Steps without `[x]` are the remainder. Steps marked done with no corresponding change are the
   interesting ones: either the box is wrong or the work was reverted.

## Anti-patterns

- **A plan that restates the repo.** Rules and conventions belong in `AGENTS.md`; reference them,
  never copy them. A copy drifts and then contradicts.
- **A plan written before reading the code.** It will be fiction, in the confident voice.
- **A plan written before asking.** Same failure, different source: assumptions you never surfaced.
- **Asking ten questions instead of three.** The interview is for forks that change the design, not
  for turning planning into an intake form.
- **A plan with no verification.** Every step becomes "it's done" and nobody can tell.
- **Planning as procrastination.** If the change is small, the honest answer is "this does not need
  a plan" — say it and do the work.
