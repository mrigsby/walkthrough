# Troubleshooting

This page is not complete yet.

## The agent stops waiting for my answer

`ask_developer` waits for your answer in the panel. After `askTimeoutSec` seconds, it tells the agent to wait again with `resume: true`. The question stays in the panel, so you can answer at any time.

The default wait is 300 seconds in Claude Code and 50 seconds in other clients. Many MCP clients stop a tool call after 60 seconds. Claude Code waits much longer, so the longer default is safe there.

We tested this on 2026-09-24. Claude Code let one `ask_developer` call wait for 120 seconds with no answer, and the call returned `status: waiting`.

To change the wait, set `askTimeoutSec` in `.walkthrough/config.yaml` (10 to 3600 seconds).

## A saved login does not work

- Walkthrough saves cookies, localStorage, and sessionStorage. It does not save IndexedDB. Some apps, such as apps that use Firebase, keep the login there. Log in at the start of the plan instead.
- Cookies can expire. Save the login again.

## A visual check fails on another computer

Fonts and smoothing differ between operating systems, so each baseline is for one system. The file name shows it, such as `cart@default-darwin.png`. The first check on a new system saves a new baseline.

## An exported script fails

- Install the browser package that the first lines of the script name: `npm install --save-dev puppeteer`, or `puppeteer-core` for a script that uses the installed Chrome.
- Set `BASE_URL` when the app runs at another address, and set the secrets that the script lists.
- A line that starts with `// Fix by hand` had no stable selector. Add a selector for that element.
- If a step failed in the run, the script fails at that step until the bug is fixed.

## The panel does not show

- The panel does not show when the browser is hidden (`headless: true` or `UIWALK_HEADLESS=1`). The agent asks you in chat instead.
- The panel does not show when `panel: false` is set in `.walkthrough/config.yaml`.
- If the panel is still missing, ask the agent to run `doctor` and to reload the page.
