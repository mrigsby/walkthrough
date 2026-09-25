---
description: Run a Walkthrough test plan in a visible browser. You confirm steps in the browser panel.
argument-hint: "[plan name] [interactive | checkpoints | autonomous]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__*
---

Run a Walkthrough test plan. Use the walkthrough skill for the details of each step.

Arguments: $ARGUMENTS

1. If the arguments name a plan, use it. If not, call `plan` with action `list`. Show the plans and ask the developer which one to run. If there are no plans, offer `/walkthrough:plan`.
2. If the arguments name a mode (`interactive`, `checkpoints`, or `autonomous`), use it. If not, use the mode in the plan.
3. Call `run_start` with the plan and the mode.
4. Do each step in the order that `run_start` gives:
   - For a "confirm" step, call `ask_developer`.
   - For an "agent checks" step, check the result yourself and call `run_step`.
   - For an "accessibility check" step, call `a11y_audit` with the `stepId`.
5. When every step has a result, or the developer says stop, call `run_finish` with a short summary.
6. Tell the developer the result, the bugs and failures, and the path to `report.html`.
7. If `run_finish` says that the plan asks for an accessibility report, write it like `/walkthrough:a11y` does, from step 3.
