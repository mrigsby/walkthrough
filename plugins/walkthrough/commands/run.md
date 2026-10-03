---
description: Run a Walkthrough test plan in a visible browser. You confirm steps in the browser panel.
argument-hint: "[plan name] [interactive | checkpoints | autonomous] [on <environment>, like: on staging]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__*
---

Run a Walkthrough test plan. Use the walkthrough skill for the details of each step.

Arguments: $ARGUMENTS

1. If the arguments name a plan, use it. If not, call `plan` with action `list`. Show the plans and ask the developer which one to run. If there are no plans, offer `/walkthrough:plan`.
2. If the arguments name a mode (`interactive`, `checkpoints`, or `autonomous`), use it. If not, use the mode in the plan.
3. If the arguments name an environment, such as `staging` or `on staging`, use it. Call `environment` with action `list` if you are not sure that it exists.
4. Call `run_start` with the plan, the mode, and the `environment` if there is one. If it says that a protected environment needs the developer's OK, tell the developer to answer in the browser, then call `run_start` again.
5. Do each step in the order that `run_start` gives:
   - For a "confirm" step, call `ask_developer`.
   - For an "agent checks" step, check the result yourself and call `run_step`.
   - For an "accessibility check" step, call `a11y_audit` with the `stepId`.
   - For a Lighthouse step, call `lighthouse` as `run_start` says.
6. When every step has a result, or the developer says stop, call `run_finish` with a short summary.
7. Tell the developer the result, the environment, the bugs and failures, and the path to `report.html`. If `run_finish` saved a video, also give its path.
8. If `run_finish` says that the plan asks for an accessibility report, write it like `/walkthrough:a11y` does, from step 3.
9. If `run_finish` says that the plan asks for a Lighthouse report, write it like `/walkthrough:lighthouse` does, from step 4.
