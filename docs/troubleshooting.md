# Troubleshooting

Start with `/walkthrough:doctor`. It checks Node, Chrome, the project folder, the settings, and the secrets. It also explains each line that starts with `FIX`.

## The uiwalk server is not connected

In Claude Code, run `/mcp`. If `uiwalk` shows as failed:

1. Run `node --version`. Walkthrough needs Node 22.12 or later. Install it from [nodejs.org](https://nodejs.org).
2. Run `/walkthrough:doctor`. If the server does not start, the command runs the server file directly and shows the error.
3. After a fix, run `/mcp` and reconnect `uiwalk`, or restart Claude Code.

## Chrome was not found

Walkthrough uses the Google Chrome on your computer. If there is none:

- Install Google Chrome, or
- Let `/walkthrough:doctor` download Chrome for Testing (about 170 MB) to `~/.cache/uiwalk`, or
- Set `browser.executablePath` in `.walkthrough/config.yaml` to the path of a Chrome.

## The site is blocked

Walkthrough opens only the sites in `allowedOrigins`. Add the site to `.walkthrough/config.yaml`:

```yaml
allowedOrigins:
  - http://localhost:3000
  - https://*.staging.example.com
```

The list replaces the default list, so also add `localhost` if you still need it. See [Settings](config.md).

## The panel does not show

- The panel does not show when the browser is hidden (`headless: true` or `UIWALK_HEADLESS=1`). The agent asks you in the chat instead.
- The panel does not show when `panel: false` is set in `.walkthrough/config.yaml`.
- If the panel is still missing, ask the agent to run `doctor` and to reload the page.

## The agent stops waiting for my answer

`ask_developer` waits for your answer in the panel. After `askTimeoutSec` seconds, it tells the agent to wait again with `resume: true`. The question stays in the panel, so you can answer at any time.

The default wait is 300 seconds in Claude Code and 50 seconds in other clients. Many MCP clients stop a tool call after 60 seconds. Claude Code waits much longer, so the longer default is safe there.

We tested this on 2026-09-24. Claude Code let one `ask_developer` call wait for 120 seconds with no answer, and the call returned `status: waiting`.

To change the wait, set `askTimeoutSec` in `.walkthrough/config.yaml` (10 to 3600 seconds).

## "Take a new snapshot"

A ref such as `e12` comes from one snapshot. When the page changes, old refs stop working, and the tool says so. The agent takes a new snapshot and tries again. This keeps a click from landing on the wrong element.

## A dialog is open

When an action opens a confirm or prompt dialog, the reply says `dialog_pending`. The agent asks you how to answer, then uses the `dialog` tool. Other tools wait until the dialog is answered. To answer dialogs without a question, set `dialogs: accept` or `dialogs: dismiss` in `.walkthrough/config.yaml`.

## Connect to your own Chrome

To test with your own logins and extensions, Walkthrough can connect to a Chrome that is already running:

1. Quit Chrome.
2. Start it with a debug port and its own profile folder:

   ```sh
   # macOS
   "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.chrome-walkthrough"
   ```

3. Ask the agent to open the browser with `attach: "http://127.0.0.1:9222"`.

Chrome 136 and later ignore the debug port for the normal profile, so `--user-data-dir` must point to another folder. Log in to your apps once in that profile. Walkthrough can also connect by the profile folder: `attach: "/Users/you/.chrome-walkthrough"`.

## A saved login does not work

- Walkthrough saves cookies, localStorage, and sessionStorage. It does not save IndexedDB. Some apps, such as apps that use Firebase, keep the login there. Log in at the start of the plan instead.
- Cookies can expire. Save the login again.

## A visual check fails on another computer

Fonts and smoothing differ between operating systems, so each baseline is for one system. The file name shows it, such as `cart@default-darwin.png`. The first check on a new system saves a new baseline.

A visual check also fails when a part of the page changes on every load, such as a date or an ad. Use `mask` with a selector for that part.

## An exported script fails

- Install the browser package that the first lines of the script name: `npm install --save-dev puppeteer`, or `puppeteer-core` for a script that uses the installed Chrome.
- Set `BASE_URL` when the app runs at another address, and set the secrets that the script lists.
- A line that starts with `// Fix by hand` had no stable selector. Add a selector for that element.
- If a step failed in the run, the script fails at that step until the bug is fixed.

## Record mode missed a step

Record mode does not record:

- clicks inside frames, such as a payment form
- your answers to confirm and prompt dialogs
- the path of an uploaded file, because the browser does not share it

Add those steps to the plan by hand. An upload step points to `fixtures/<file name>`. Put the file there, or fix the path.

## npm install fails with EBADENGINE

npm 11.5.0 to 11.6.1 has a bug that removes a part of the test tools. The project blocks these versions. Run `npm install -g npm@11`, then remove `node_modules` and `package-lock.json`, and run `npm install` again. This matters only if you work on Walkthrough itself.

## More detail

- Set `UIWALK_LOG_LEVEL=debug` to see more server logs. In Claude Code, `claude --debug` shows more detail about MCP servers.
- Set `UIWALK_TRACE_FILE=/tmp/uiwalk-trace.jsonl` to write one line for each action, with the element under each click.
