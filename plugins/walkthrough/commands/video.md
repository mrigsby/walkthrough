---
description: Make a demo video of a workflow. It writes or uses a plan, runs it, and records a clean replay as MP4 and GIF.
argument-hint: "<workflow, like: the checkout, or a plan name> [mp4 | webm | gif] [path, like docs/images/checkout.gif]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__*, Read, Grep, Glob
---

Make a demo video of a workflow. Use the walkthrough skill, and follow `references/video.md` to write the plan.

What to record: $ARGUMENTS

1. Find the plan:
   - Call `plan` with action `list` to see the saved plans. If an argument is the exact name of a saved plan, use it.
   - Otherwise, use a saved plan only when its name or title says it is a demo or video of the workflow, like `checkout-demo`. Do not use a test plan for a video. Its steps check for bugs, and they can fail.
   - An argument `mp4`, `webm`, or `gif` is a format. An argument that ends in `.mp4`, `.webm`, or `.gif` is a file to save the video to.
   - With no workflow and no plan, ask the developer what to record.
2. If there is no plan for the workflow, write one:
   1. Look at the app with `browser_open`, `navigate`, and `snapshot` to get the real names of buttons, links, and fields. Do not submit forms or change data while you look.
   2. Write the plan in YAML, and follow `references/video.md`. Give every step an exact `action` and a short `caption`. Use `{{unique}}` for data that must be new each time, and `{{secret:NAME}}` for passwords. Set `mode: autonomous` and `video: true`.
   3. If a fact is missing, like a login or test data, ask the developer. Do not ask about anything else.
   4. Call `plan` with action `validate` and the YAML as `content`. Fix any problems.
   5. Call `plan` with action `save`, with a short name like `checkout-demo`. If a plan with that name exists, ask before you replace it.
3. Run the plan. Call `run_start` with the plan, do each step as `run_start` says, and then call `run_finish`. Check every step. The run and the replay each do the workflow once, so the app gets the data two times, like two orders.
4. If a step fails, stop. Tell the developer which step failed and why. Do not record a broken workflow unless the developer asks for it.
5. Record the clean replay: call `video` with action `replay`, the `runId` from `run_start`, and:
   - `format`: the formats the developer asked for. The default is `[mp4, gif]`: the MP4 to watch, and a GIF preview.
   - `path`: the files the developer asked for, like `docs/images/checkout.gif`.
   - `pace`: `slow` if the developer wants a slower video, `fast` for a quick one. The default is `normal`.
6. If the replay stops at a step, show the developer the step, the error, and the screenshot. Fix the plan step, and run the plan again from step 3.
7. Tell the developer:
   - the files, with the length and size of each
   - where each format plays: MP4 in most players, on GitHub, and in Slack. GIF in Markdown, email, and issues. WebM in browsers.
   - how to make it again: `/walkthrough:video <plan>` for a new run, `video` with action `replay` for the same run, or `/walkthrough:export` with `VIDEO=<file>.mp4` in CI
