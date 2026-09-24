---
description: Write a new Walkthrough test plan from a plain description of what to test.
argument-hint: "<what to test, like: log in and change my display name>"
allowed-tools: mcp__plugin_walkthrough_uiwalk__plan, mcp__plugin_walkthrough_uiwalk__browser_open, mcp__plugin_walkthrough_uiwalk__navigate, mcp__plugin_walkthrough_uiwalk__snapshot, mcp__plugin_walkthrough_uiwalk__read, mcp__plugin_walkthrough_uiwalk__wait_for
---

Write a new test plan for the developer.

What to test: $ARGUMENTS

1. If there is no description, ask the developer what to test.
2. Look at the app to get the real names of buttons, links, and fields. Use `browser_open`, `navigate`, and `snapshot`. Do not submit forms, buy, delete, or change data while you look, unless the developer agrees.
3. Write the plan in YAML. Follow the "Write a plan" section of the walkthrough skill and `references/plan-format.md`.
   - Give each step an `id`, a `do`, and a specific `expect`.
   - Mark the important steps with `checkpoint: true`.
   - For passwords, use `{{secret:NAME}}`, never the real value.
4. Call `plan` with action `validate` and the YAML as `content`. Fix any problems.
5. Show the plan to the developer. Ask for a plan name, such as `change-name`, and for any changes.
6. Call `plan` with action `save`. If a plan with that name exists, ask before you replace it.
7. Tell the developer how to run it: `/walkthrough:run <name>`.
