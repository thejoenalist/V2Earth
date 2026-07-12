# Working with Opus 4.8 — General Handoff Guide

Written 2026-07-04 with Claude Fable 5. This is the general half of the
handoff; the project-specific half is CLAUDE.md + DECISIONS.md + the skills
in `handoff/skills/` (move to `.claude/skills/`). These notes apply to any
project, not just Earth Simulator V2.

## The honest premise

No document makes a smaller model reason like a larger one. What a handoff
CAN transfer, in descending order of value:

1. **Decisions already made** — so they never get remade badly (DECISIONS.md).
2. **Judgment converted to mechanical checks** — a grep the model runs beats
   an instinct it lacks (verify scripts, audit checklists).
3. **Worked examples** — models are excellent at pattern-matching a
   gold-standard file; point to one explicitly instead of describing style.
4. **Predicted failure modes** — naming the specific mistake in advance
   ("don't inline ISO codes") is far more effective than general advice
   ("be careful").

Structure every future instruction file around those four.

## How to run Opus 4.8 sessions

**One task per session.** Long mixed sessions degrade any model. Start each
session with the CLAUDE.md pointer prompt and a single concrete goal.

**Make it plan before it edits.** For anything touching 2+ files: "List the
files you'll change and what changes, then wait for my go." Reviewing a plan
is cheap; reviewing a diff sprawl is not.

**Never accept "done" without evidence.** The standing rule: a task is
complete when the verify script passes and the model shows the output. Ask
for the command output, not the model's summary of it. If there's no verify
script for the kind of work you're doing, the first task is to write one.

**Ask it to state assumptions.** "Before you start, list what you're assuming
about the codebase." Wrong assumptions surface in 10 seconds instead of in a
broken diff.

**Watch for these smaller-model tells:**
- Confident completion claims without having run anything. Counter: evidence rule above.
- Re-solving problems locally that have a project-wide solution. Counter: "grep before you write" instruction.
- Quietly narrowing scope when a task gets hard (implements 4 of 6 steps,
  reports success). Counter: numbered definition-of-done lists in skills;
  make it echo the list with a status per item.
- Over-agreeing with a bad idea you float. Counter: ask "argue against this
  first," then decide.
- Drifting from instructions over a long session. Counter: shorter sessions;
  re-paste the relevant skill when quality dips.

## Maintaining the handoff corpus

- When Opus makes a mistake the docs didn't predict, don't just fix the code —
  add the mistake to the relevant skill or CLAUDE.md failure-modes list.
  The corpus should grow one entry per surprise.
- When a decision changes, update DECISIONS.md in the same commit, with the
  new rationale and date.
- Keep every rule paired with its check. A rule with no grep/script/test
  attached will eventually be violated silently.
- Prefer editing the existing skill over writing a new overlapping one;
  overlapping instructions rot into contradictions.

## Prompts that work well (copy-paste starters)

Session start:
> I'm continuing Earth Simulator V2. Read CLAUDE.md, DECISIONS.md, and the
> relevant skill before touching anything. Today's single goal: [X].
> List your plan and assumptions first; don't edit until I confirm.

Before merge:
> Run the audit-checklist skill end to end. Show PASS/FAIL per item with
> file:line evidence, plus the `npm run verify` output verbatim.

When it claims done:
> Echo the skill's definition-of-done list with a status per item, and paste
> the verify output. Anything not green means not done.

When you suspect drift:
> Stop. Re-read [skill/CLAUDE.md section]. Which of its rules does your
> current diff violate?
