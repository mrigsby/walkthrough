# Troubleshooting

This page is not complete yet.

## The agent stops waiting for my answer

`ask_developer` waits for your answer in the panel. After `askTimeoutSec` seconds, it tells the agent to wait again with `resume: true`. The question stays in the panel, so you can answer at any time.

The default wait is 300 seconds in Claude Code and 50 seconds in other clients. Many MCP clients stop a tool call after 60 seconds. Claude Code waits much longer, so the longer default is safe there.

We tested this on 2026-09-24. Claude Code let one `ask_developer` call wait for 120 seconds with no answer, and the call returned `status: waiting`.

To change the wait, set `askTimeoutSec` in `.walkthrough/config.yaml` (10 to 3600 seconds).

## The panel does not show

- The panel does not show when the browser is hidden (`headless: true` or `UIWALK_HEADLESS=1`). The agent asks you in chat instead.
- The panel does not show when `panel: false` is set in `.walkthrough/config.yaml`.
- If the panel is still missing, ask the agent to run `doctor` and to reload the page.
