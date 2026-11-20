---
name: deliver
description: >-
  Triage and deliver an implementation request end to end: study the scope, ask only the
  decision questions that matter (grilling style, depth scaled to uncertainty), write a formal
  plan only when the risk test demands it, then execute. Use for any request to change code —
  build, add, fix, change, migrate, refactor — and whenever someone asks "plan how to…",
  "what's the approach for", "write a plan", "grill me", "stress-test this", or
  "interview me about this". Also covers decision-only grilling: stress-testing a plan, decision,
  or idea until shared understanding, with no code written. NOT for a pure question ("why is this
  test red?"), a review, an explanation, a training or coaching plan, or a to-do list.
---

# Delivering work

One workflow, from request to done:

1. **Study** the scope. 2. **Classify** and announce. 3. **Interview** what is undecided.
4. **Summarise** the shared understanding. 5. Apply the **risk test** to pick the artefact.
6. **Execute** — directly, from an inline plan, or under a formal plan.

Two independent dials drive it. Do not collapse them into "task size":

- **Uncertainty** — how many decision forks are open — sets *how many questions*.
- **Risk** — reversibility, durability, cost of a wrong guess — sets *whether there is a plan
  document and an approval gate*.

A one-file production purge is small code and high risk. A twenty-file mechanical rename is
large and low risk. The dials, not the file count, decide.

## 1. Study first

Before asking anything, read the request, the project's `AGENTS.md`, the code and tests that
will change, and recent git history. **Never ask a fact the environment can answer** — files,
configs, existing patterns, and docs are looked up, not interviewed. Questions are for decisions
the user owns: goals, scope, trade-offs, priorities, constraints, risk tolerance, what "done"
means.

## 2. Classify and announce

State the classification and the question budget in one line before the interview:

```text
[INFO] Classified: medium uncertainty, low risk. Up to 6 questions, then I work directly.
[INFO] Classified: low uncertainty, high risk. 2 questions, then a plan file for your approval.
```

Reclassify if the study or the answers change the picture, and say so.

## 3. Interview — grilling style, scaled by uncertainty

Walk the decision tree in dependency order: goal and scope before implementation details,
interfaces before internals, blockers first. Each question is one of the most important
remaining decisions, and carries:

- a **why** — the step, file, or verification line the answer changes (the user sees it as
  `asked because: …`; if you cannot name one, drop the question — `ask_user` refuses it anyway),
- a **recommended answer** with a brief reason. Do not soften every recommendation into
  "whatever you prefer"; give a clear default.

Dependent forks are asked one at a time, because the next question depends on the answer.
Independent forks may be batched in one `ask_user` call. When an answer collapses a branch,
drop the questions planned for it. Answered means locked: never re-ask, never rephrase the same
decision to check.

Budgets are hard ceilings, never quotas — stop as soon as remaining uncertainty is low, and stop
immediately if the user says enough:

| Uncertainty | Budget | When |
|---|---|---|
| Low | 0–3 | The request is nearly a spec; at most, the assumption you were about to make silently |
| Medium | 3–6 | A few real forks: scope boundary, input source, success criterion |
| High | 8–15 | Architecture, product direction, multi-system work; never exceed 15 |

Use `ask_user` for the interview (it is available in and out of plan mode), before any plan is
written. Mid-way, if a material fork appears, ask again rather than picking one quietly.

**Decision-only exit.** If the user wants a plan, decision, or idea stress-tested ("grill me",
"pressure-test this") rather than built, the interview is the whole job: finish at the shared
understanding (step 4), ask for confirmation, and do not implement or act until they confirm and
give a next instruction.

## 4. Shared understanding

Close the interview with a summary:

- **Goals and non-goals**
- **Decisions locked** (with the chosen options)
- **Open risks still accepted**
- **Ready to act**, or **still blocked on X**

For low-risk work this summary, confirmed by the user, is the only gate — a soft, conversational
one. For high-risk work it is not a second approval: it becomes the formal plan's Context, and
the real gate is `/plan go`.

## 5. The risk test — which artefact?

Applied *after* the interview, because the answers are what reveal the risk. An explicit request
for a plan is the strongest signal and skips the test. Otherwise ask in order; the first **yes**
settles it:

1. **Is it irreversible or expensive to undo?** A migration, a data backfill, a destructive
   script, a deploy, a change other branches depend on.
2. **Must it be reconstructable from something other than this chat?** Work that spans sessions,
   is handed over, or whose *order* a later reader will question.
3. **Is a wrong guess costly?** If the mistake surfaces at step 4 and means throwing away
   steps 1–3 rather than editing one file, it needed the gate.
4. **Is the `files:` list not yet nameable?** If the study did not produce the file list, you do
   not know the change well enough to execute it either.

Outcomes:

- **Explicit plan request, or any yes** → **formal plan.** If plan mode is off, call
  `request_plan_mode` first. An interview already done this session is carried in — do not
  re-ask what it settled. Investigate read-only, write the plan with `write_plan`, then stop.
  Only the human leaves the gate, with `/plan go` (execute here) or `/plan exit` (keep the file,
  execute nothing). Never simulate either, and never "write the plan anyway" with normal write
  tools — that produces a document with no gate behind it.
- **No yes, but order matters and is worth stating** → **inline mini-plan**: a few numbered
  steps with a check each, in chat. No file, no gate; confirmed with the step-4 summary.
- **No yes** → **work directly**, in vertical slices, with a checkpoint after the first testable
  one. This covers the small work. Multi-file is a proxy, not a reason — a route, a page, and a
  readme is four files and one revert. If the plan would be longer than the diff, just do the
  work. Planning as procrastination is a failure mode, not diligence.

## 6. Execute

**Direct and inline work:** build in vertical slices, prove each with the project's tests or a
measurable check, and keep the user checkpoint after the first testable slice. If execution
reveals the classification was wrong — a fork that throws away earlier steps, a file list that
will not settle — stop and escalate to a formal plan via `request_plan_mode` rather than pushing
on.

**Formal plans** run under the `plan` extension, which enforces what a prompt cannot:

| while planning | enforced by |
|---|---|
| `edit` / `write` are not available | tool set |
| `bash` is read-only by default | per-segment allowlist |
| a command it does not know | you ask the human — they answer, not you (allow-all mode skips the question) |
| the plan is written from answers | `write_plan` refuses until an interview is usable (asked in plan mode, or carried unconsumed from this session) |
| the plan is a file in `docs/plans/` | `write_plan` is the only write channel |
| nothing executes before approval | the tool set is restored only by `/plan go` |
| edits stay inside the plan's file list | `tool_call` interceptor, except the plan document itself |

Investigating is part of planning: reading, searching, `git log|diff|show`, and `npm ls` just
run. For anything else, try it — the human is asked. A refusal means the plan does not need that
command; plan around it, and do not retry a refused command in a new shape.

### The document

`write_plan` decides the path and the frontmatter; you supply the body. The interview answers go
in Context — they are the part a later reader cannot reconstruct.

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
Two or three sentences: what exists now, what is wrong with it, what this plan produces. Name
the files you read to find out. State assumptions explicitly — an assumption you write down is a
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

One verification line per step is the whole difference between a plan and a wish list:

- bad: `2. Add the endpoint to the backend.`
- good: `2. **Add `GET /api/activities`** to backend/main.py, returning the archive ⋈ journal join.
  *Verify:* `curl -s localhost:8000/api/activities | jq length` equals the FIT count.`

A step whose check is "it works" is not a step. If you cannot name a check, the step is not
ready to be planned — that is a finding, so put it under Open questions instead of inventing
confidence.

### Lifecycle and resuming

`status:` is `draft → approved → in_progress → done | abandoned | superseded`.

- The plan is **mutable while current**: tick steps, add a line when a step turns out to be
  wrong. The plan document is always writable during execution.
- A written plan is **frozen once superseded**. A revision is a *new* file with `supersedes:`,
  never an edit of the old one.
- When the work lands, set `status: done` in the same commit. A plan left at `in_progress`
  after the code shipped is a lie with a filename.
- `write_plan` refuses to overwrite an existing file: two plans with one name is two sources of
  truth.

A later session picks up from the file, not from memory:

1. `ls -t docs/plans/ | head -3`, open the newest with `status: in_progress` or `draft`.
2. `git log --oneline` since the plan's `created` date — work may already be done.
3. Steps without `[x]` are the remainder. Steps marked done with no corresponding change are
   the interesting ones: either the box is wrong or the work was reverted.

## Anti-patterns

- **Asking facts the repo can answer.** Look them up; the interview is for decisions.
- **Padding to the budget.** The ceiling is not a quota; a collapsed branch kills its questions.
- **Interviewing twice.** A grilling that pinned the design, or an `ask_user` round carried into
  plan mode, is settled — ask only what it left open.
- **A plan that restates the repo.** Rules belong in `AGENTS.md`; reference them, never copy
  them. A copy drifts and then contradicts.
- **A plan written before reading the code, or before asking.** Fiction in a confident voice,
  from two different sources.
- **A plan with no verification.** Every step becomes "it's done" and nobody can tell.
- **Planning theatre for small work.** If it is reversible, nameable, and cheap to get wrong,
  the honest answer is "this does not need a plan" — say it and do the work.
