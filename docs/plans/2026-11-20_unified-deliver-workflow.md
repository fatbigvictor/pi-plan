---
title: unified deliver workflow
created: 2026-11-20
status: done
files:
  - skills/deliver/SKILL.md
  - skills/plan/SKILL.md
  - extensions/plan/index.ts
  - extensions/plan/utils.ts
  - extensions/plan/utils.test.ts
  - extensions/plan/README.md
  - README.md
  - package.json
---

# Merge grilling and plan mode into one unified delivery workflow

## Context
Today the interview behaviour lives in two places that overlap: the standalone `grilling` skill
(`~/.pi/agent/skills/grilling/SKILL.md`, unversioned) and the `plan` skill plus `ask_user` gate in
this repo (`skills/plan/SKILL.md`, `extensions/plan/index.ts`). The new design is one workflow driven
by two independent dials: **uncertainty** controls question depth, **risk** (irreversible or
expensive to undo, must outlive the chat, costly wrong guess, `files:` not yet nameable) controls
whether a formal plan document and the `/plan go` gate apply. Flow: study the scope, classify and
announce, interview in grilling style, summarise shared understanding, apply the risk test, then
work directly, follow an inline mini-plan, or enter formal plan mode.

Decisions already made (interview answers plus two delegated to agent recommendation):
- New `skills/deliver/SKILL.md` replaces `skills/plan/SKILL.md` (recommendation: the workflow is
  delivery; planning is one branch, and small tasks must be able to short-circuit to direct work).
- Auto-triage every implementation request; small clear tasks short-circuit. Skill-triggered only,
  no `/deliver` command in this change.
- Interview carry-over: an unconsumed interview from `ask_user` earlier in the same session
  satisfies `write_plan` after entering plan mode; it is consumed by a successful `write_plan` and
  cleared on `/plan go`, `/plan exit`, and leaving plan mode off. Only interview metadata (counts
  and availability) is persisted — the Q&A text already lives in the session transcript.
- Decision-only grilling is a mode of the unified skill (summary and confirmation, no code),
  not a separate packaged skill.
- Extension keeps its identity: `extensions/plan/` and the `/plan` commands stay (recommendation:
  the extension is the plan-mode gate mechanism; renaming buys nothing and risks regressions).
- After release, retire the local `~/.pi/agent/skills/grilling/` copy (deployment step, outside
  this repo, done only after the packaged skill is confirmed working).
- Branch stays `master` (this repo's established convention); version bumps `0.2.0` to `0.3.0`.

Key code facts from reading `extensions/plan/index.ts`: `interviewed` is a bare boolean, reset
unconditionally in `enterPlanMode()`, persisted via `persist()` and restored on `session_start`
(legacy entries carry only `interviewed`), set by `ask_user` when at least one answer exists, and
the `before_agent_start` plan-mode prompt currently says INTERVIEW FIRST unconditionally.

## Steps
1. [x] **Add pure interview-state transitions to `extensions/plan/utils.ts`** — a small interview state (asked/answered counts, availability) with transitions: record an interview, enter plan mode preserving an available unconsumed interview, consume on successful plan write, clear on gate exit, and derive availability from a legacy `{ interviewed: true }` state. Write the failing tests first in `extensions/plan/utils.test.ts`.
   *Verify:* `npm test` fails on the new cases before the implementation and passes after, with all pre-existing gate tests still green.
2. [x] **Wire the transitions into `extensions/plan/index.ts`** — `enterPlanMode()` no longer resets an available carried interview; `ask_user` records through the new transition; successful `write_plan` consumes it; `approve()`, `exitPlanMode()`, and `leavePlanMode()` clear it; `session_start` restores new state and tolerates legacy state; headless (`!ctx.hasUI`) behaviour is unchanged. `/plan status` shows carried/consumed interview state.
   *Verify:* in a scratch directory (not this repo) with the dev extension loaded, four checks: fresh plan mode still refuses `write_plan` before any interview; an interview run in normal mode then `request_plan_mode` allows `write_plan` with no re-ask; after `/plan go` or `/plan exit`, a second plan requires a fresh interview; `/plan status` reflects each state.
3. [x] **Make the plan-mode prompts conditional and study-first** — the `request_plan_mode` result text and the `before_agent_start` plan-mode context say "interview already done: ask only what it left open" when a carried interview is available, and otherwise permit a quick scope read (AGENTS.md plus the files that will change) before the interview. Update references from the `plan` skill to the `deliver` skill.
   *Verify:* both prompt paths inspected in the diff; scratch-session check that entering plan mode after an interview does not instruct a fresh interview.
4. [x] **Write `skills/deliver/SKILL.md` and remove `skills/plan/SKILL.md`** — the unified skill: auto-triage trigger for implementation requests (not questions, reviews, or explanations); the two dials; stages study, classify-and-announce, interview, shared understanding, risk test, execute; question budgets by uncertainty (0-3 low, 3-6 medium, 8-15 high, hard cap 15, never padded); grilling style (dependency order, recommended answer with each question, dependent forks one at a time, independent forks may batch); soft confirmation gate for medium tasks; the risk test with Q4 phrased as "is the `files:` list not yet nameable" (fixing the current inverted wording); decision-only exit; the retained plan document convention, lifecycle, resuming, and anti-patterns from the old plan skill.
   *Verify:* a new pi session lists and can load the `deliver` skill; scenario walkthrough in a scratch session: small clear request goes direct with no plan file, medium request gets questions plus a summary confirmation, decision-only request ends at a summary with no code changes.
5. [x] **Update docs and package metadata** — root `README.md` and `extensions/plan/README.md` describe the unified workflow, the two dials, and interview carry-over; layout sections name `skills/deliver/`; `package.json` description widened and version set to `0.3.0`.
   *Verify:* `rg "skills/plan" README.md extensions package.json` and `rg "\`plan\` skill" extensions/plan/index.ts README.md extensions/plan/README.md` return only intentional historical mentions; `git diff --check` is clean.
6. [x] **Run the full quality gate and prepare the release** — `npm test`, `git status`/`git diff` review, confirm no new `TODO`/`FIXME` in touched files, and summarise the change for the user. Commit, push, `pi update --extensions`, and retiring the local grilling copy are NOT part of this step: they wait for separate explicit user approval.
   *Verify:* `npm test` green, diff limited to the declared `files:` (plus this plan document), and a written summary states what is ready and what still needs approval.

## Risks
- Stale interview: an unrelated `ask_user` round earlier in a session could satisfy a later plan.
  Mitigated by consume-on-write and clear-on-exit, and visible in `/plan status`; the residual
  same-session risk is accepted by the user's carry-over choice.
- Persisted-state compatibility: sessions saved by 0.2.0 carry only `interviewed`. Restore must
  derive availability from it or old sessions lose their interview state (step 1-2 cover this).
- Auto-triage over-triggering: a broad skill description could tax trivial requests in other
  projects. Mitigated by the small-clear short-circuit and explicit not-for list (questions,
  reviews, explanations).
- Removing `skills/plan` breaks any external reference to `/skill:plan`; accepted, noted in the
  README, and the reason for the minor version bump rather than a patch.
- Interview-first ordering: formal plan mode entered cold (no prior study) still needs grounded
  questions; step 3 permits a quick scope read first instead of interrogating blind.

## Open questions
- None blocking. Commit granularity (one `feat` commit vs separate extension and skill commits)
  is decided at the release step, with the user's approval.
