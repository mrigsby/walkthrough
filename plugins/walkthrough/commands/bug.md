---
description: Turn a bug from a Walkthrough run into a GitHub issue. You see the draft, and you submit it yourself.
argument-hint: "[run folder name] [step id]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__issue_draft, mcp__plugin_walkthrough_uiwalk__runs
---

Draft a GitHub issue for a bug that a Walkthrough run found.

Arguments: $ARGUMENTS

1. Call `issue_draft` with the run folder name and the step id from the arguments. If there are none, it uses the first bug in the newest finished run.
2. Show the developer the title and the body. Ask for changes. If they want changes, edit the body file.
3. Find the GitHub repository. Run `gh repo view --json nameWithOwner --jq .nameWithOwner`.
   - If `gh` is not installed or not logged in, tell the developer. Give them the title and the body file, so they can make the issue by hand. Stop here.
   - If the project is not a GitHub repository, ask the developer for the repository, such as `owner/name`.
4. Ask the developer: "Open a new issue page for <repository> in your browser?" Do not continue until they say yes.
5. Run `gh issue create --web --repo <repository> --title "<title>" --body-file <body file>`. Quote the title for the shell. Always use `--web`. Never create the issue directly.
6. Tell the developer that the issue page is open, with the title and the body. List the full paths of the screenshots, and tell them to drag the files into the issue before they submit it. On macOS, offer to show the files in Finder with `open -R <path>`.
