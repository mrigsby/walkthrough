---
description: Give a live presentation of a flow. It rehearses the plan, opens an audience window and a presenter window, and answers the presenter's chat questions.
argument-hint: "<plan name, or a flow to show> [on <environment>] [kiosk] [record]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__*, Read, Grep, Glob
---

Give a live presentation. Use the walkthrough skill, and follow `references/presentation.md`.

What to present: $ARGUMENTS

1. Read the arguments:
   - `on <environment>`, like `on staging`, names the environment.
   - `kiosk` runs the presentation with no presenter.
   - `record` asks for a video of the audience screen.
   - The rest names the plan or the flow. With nothing named, ask the developer what to present.
2. Find the plan:
   - Call `plan` with action `list`. If an argument is the exact name of a saved plan, use it.
   - Otherwise, use a plan whose name or title says it is a tour, demo, or presentation of the flow, like `checkout-tour`.
   - A plan with no `presentation` block works too. Offer to add notes, captions, and an agenda slide first.
3. If there is no plan for the flow, write one:
   1. Look at the app with `browser_open`, `navigate`, and `snapshot` to get the real names of buttons, links, and fields. Do not submit forms or change data while you look.
   2. Write the plan in YAML. Follow `references/presentation.md`: an exact `action` on every step that does something, a short `caption`, short `notes`, and an agenda slide.
   3. If a fact is missing, like a login or test data, ask the developer.
   4. Call `plan` with action `validate` and the YAML as `content`. Fix any problems.
   5. Show the plan to the developer. Save it with `plan` action `save` after they agree, with a short name like `checkout-tour`.
4. If the developer asked for `record` and the plan has no `record`, add `record: true` to the `presentation` block, and save the plan.
5. Call `present` with action `start`, the plan, and the `environment` and `kiosk` from the arguments.
   - On `no_rehearsal`: rehearse. Call `run_start` with the plan, mode `autonomous`, and the environment. Do each step exactly as its `action` says, check it, and call `run_step`. Call `run_finish`. Then call `present` with action `start` again.
   - If a step of the rehearsal fails, stop. Tell the developer which step failed and why. Do not present a broken flow.
   - On `not_presentable`, fix what the reply says, such as a step with no exact action, and rehearse again.
   - Never confirm a protected environment yourself. When the reply says that the presenter must confirm it, tell the developer to click **Present here** in the presenter window.
6. Tell the developer, in a few short lines:
   - Drag the audience window to the projector, or click **Other screen** in the presenter window. In a video call, share only the audience window.
   - Click **Start**, or press the right arrow. The right arrow or Page Down plays the next step, and B blanks the screen.
   - Ask questions in the chat of the presenter window. You listen until the end, so this terminal stays busy. Escape here stops the listening, not the presentation.
7. Listen. Call `present` with action `listen`, and act on each reply:
   - `status: question`: answer with `present` action `answer`, the `id`, and the `text`. Follow the answer rules in `references/presentation.md`: 1 to 3 short sentences in plain text. Then listen again.
   - `status: step_failed`: look at the page with `snapshot`, `read`, or `logs`. Send a short note with `present` action `answer` and no `id`. Say the likely cause, and that the presenter can retry, skip, or do it by hand. Then listen again.
   - `status: waiting`: listen again.
   - `status: superseded`: another listen call took over. Stop this loop.
   - `status: canceled`: the developer stopped the listening. Ask in chat whether to listen again. The presentation goes on.
   - `status: ended`: go to step 8.
   - Use `present` action `control` only when the developer asks you for a command.
8. Call `present` with action `stop`. Tell the developer the summary, and where the handout and the video are.
