---
description: Check pages with Lighthouse and write a report with scores, explanations, and fixes.
argument-hint: "[pages like / /login, a pages.txt file, or a plan name] [mobile or desktop] [on <environment>]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__*, Read, Grep, Glob
---

Check the app with Lighthouse, and write the Lighthouse report. Use the walkthrough skill, and follow `references/lighthouse-report.md` to write the text.

What to check: $ARGUMENTS

1. Call `lighthouse` with action `status`. If Lighthouse is not installed, show the developer the install command from the reply. Ask them to run it in a terminal, and wait until they say it is done.
2. Find out what to check:
   - An argument that starts with `/` or `http` is a page.
   - An argument that ends in `.txt` is a file in the project with one page on each line. Read it. Skip empty lines and lines that start with `#`.
   - `mobile` or `desktop` sets the device. Without it, Walkthrough uses the device from `config.yaml`.
   - An environment, such as `staging` or `on staging`, sets `environment` for `lighthouse` or `run_start`. To compare two environments, check each one in its own run, then call `lighthouse_report` for the second one with `compareTo` set to the first run.
   - Any other argument is a plan name.
   - With no arguments, ask the developer which pages to check.
3. Check the pages:
   - For pages, call `lighthouse` with `urls`, and `device` if the developer gave one. If the reply says to call it again with `runId`, do that until it has checked all pages.
   - For a plan, run it like `/walkthrough:run` does. For each Lighthouse step, call `lighthouse` as `run_start` says. The plan or `config.yaml` sets the device. If the plan has no Lighthouse steps, tell the developer. Offer to add them (see "Lighthouse flows" in `references/plan-format.md`), or to check its pages with `urls` instead.
4. Call `lighthouse_report` with the `runId`, and no items. Keep the `digest`.
5. If the app's source code is in this project, find where to fix each issue. Follow "Find where to fix" in `references/lighthouse-report.md`. Add up to 3 places to `where` for each issue. If you cannot find an issue in the source, omit `where`. Never guess a file.
6. Write `explain` and `fix` for every issue, and `code` when an example helps. Write a `summary` of 2 to 4 sentences.
7. Call `lighthouse_report` again with `runId`, `digest`, `summary`, and `items`.
8. Tell the developer:
   - the scores of each page or flow step, and the three issues to fix first
   - what changed since the last report, if the report compares with an earlier one
   - the path to `lighthouse.html`, and for a plan, the path to Lighthouse's flow report
   - that scores from a dev machine change from run to run, so the changes between runs matter more than the numbers
9. Show the suggested prompt from the reply in a code block. Tell the developer to paste it into a new session to plan the fixes.
