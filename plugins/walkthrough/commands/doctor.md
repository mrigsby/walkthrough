---
description: Check that Walkthrough can run in this project, and explain how to fix problems.
allowed-tools: mcp__plugin_walkthrough_uiwalk__doctor
---

Check the Walkthrough setup for the developer.

1. Call the `doctor` tool from the uiwalk server. Show the result to the developer.
2. For each line that starts with `FIX`, explain the fix in one or two plain sentences.
3. If Chrome is missing, the developer can install Google Chrome. Or, with the developer's approval, run this command to download Chrome for Testing (about 170 MB):
   `node "${CLAUDE_PLUGIN_ROOT}/server/uiwalk.mjs" setup`

If the uiwalk tools are not available, the server did not start. Then do these checks:

1. Run `node --version`. Walkthrough needs Node 22.12 or later. If Node is missing or older, tell the developer to install it from https://nodejs.org.
2. Run `node "${CLAUDE_PLUGIN_ROOT}/server/uiwalk.mjs" doctor` and show the output.
3. After a fix, tell the developer to run `/mcp` and reconnect `uiwalk`, or to restart Claude Code.
