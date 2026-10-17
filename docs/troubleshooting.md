# Troubleshooting

Start with `/walkthrough:doctor`. It checks Node, Chrome, the project folder, the settings, the secrets, Lighthouse, and ffmpeg. It also explains each line that starts with `FIX`.

## The uiwalk server is not connected

In Claude Code, run `/mcp`. If `uiwalk` shows as failed:

1. Run `node --version`. Walkthrough needs Node 22.19 or later. Install it from [nodejs.org](https://nodejs.org).
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

## The site of another environment is blocked

While you test one environment, Walkthrough blocks the sites of the others. The reply names the environment of the site. To test there, ask the agent to switch, such as "switch to staging". See [Environments](environments.md).

## Walkthrough asks to confirm production

Production, and any environment with `protected: true`, needs your OK before Walkthrough opens a page there. Click **Use Production** in the panel. Your OK lasts until the browser closes. Click **Cancel** to go back to the environment from before. With a hidden browser and a client that cannot ask, set `UIWALK_ALLOW_PROTECTED=production`, but only for automation that you trust.

## A secret works on development but not on staging

Each environment reads `.walkthrough/.env.<name>` first, such as `.env.staging`. A protected environment never reads the plain `.env`. Put the value in the file of that environment. `environment` with action `show` lists the secret names it can read.

## The panel does not show

- The panel does not show when the browser is hidden (`headless: true` or `UIWALK_HEADLESS=1`). The agent asks you in the chat instead.
- The panel does not show when `panel: false` is set in `.walkthrough/config.yaml`.
- If the panel is still missing, ask the agent to run `doctor` and to reload the page.

## The window is smaller than the page

Walkthrough fits the window to the page: 1280 x 800 by default, or the size of a device, like `desktop`. When the screen is too small, the window gets as big as the screen allows, and the reply says so. Chrome can open a new window on another screen. Move it to the bigger screen, or use a smaller size in `browser.window`.

With DevTools docked at the right, the window grows by the width of DevTools. On a small screen, dock DevTools at the bottom or in its own window: `devtools: { dock: window }`.

## Device settings do nothing

When DevTools shows its device toolbar (`devtools: { deviceToolbar: true }`), DevTools controls the page size. `emulate` then does not set a device or an orientation, and says so. Choose the device and turn it in the toolbar, or turn the toolbar off.

An `orientation` needs a device, such as `mobile` or `tablet`.

## A download is missing

Downloads go to the run folder only when the plan or `config.yaml` sets `browser.downloads: true`, and only during a run. Look in the `downloads` folder of the run. With your own Chrome (`attach`), downloads go where your Chrome puts them.

## An extension does not load

- An extension must be an unpacked folder with a `manifest.json`.
- A plan can name only folders in the project. Put a full path in `browser.extensions` in `config.local.yaml`.
- With extensions, Chrome starts in another way (a pipe), so tools that connect to Chrome by its address cannot reach it.

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

## A new tab opens in its own window

A tab with a separate login (`isolated`) opens in a new Chrome window, like a private window. This is how Chrome keeps the logins apart. The other tools work on it as usual. Close the tab, or switch to another tab with the `tabs` tool.

## Lighthouse is not installed

Lighthouse is an optional download. Install it from a terminal with `npx -y walkthrough-ui setup lighthouse`. In Claude Code, the reply of the `lighthouse` tool shows the exact command for the plugin. See [Lighthouse reports](lighthouse.md#set-up).

## Lighthouse scores change each time

Lighthouse runs on your computer, so other programs change its timing. Compare the changes between reports more than the numbers. See [Scores change from run to run](lighthouse.md#scores-change-from-run-to-run).

## A video is WebM, freezes, or is too big

See [Troubleshooting](video.md#troubleshooting) in the video guide. In short:

- For MP4, Walkthrough needs a Chrome that can make H.264, or ffmpeg. Install ffmpeg with `npx -y walkthrough-ui setup ffmpeg`.
- Chrome draws nothing for a minimized window. Do not minimize the test browser while it records.
- Use MP4 instead of GIF for videos longer than a few seconds.

## A replay stops at a step

`video` with action `replay` does the run again in a new login. When a step does not work, it stops and names the step. Fix the plan step, and run the plan again. See [The replay stopped at a step](video.md#the-replay-stopped-at-a-step).

## A saved login does not work

- Walkthrough saves cookies, localStorage, and sessionStorage. It does not save IndexedDB. Some apps, such as apps that use Firebase, keep the login there. Log in at the start of the plan instead.
- Cookies can expire. Save the login again.
- Each environment has its own saved logins. A login saved on development does not load on staging. Log in on staging, and save it there.

## A visual check fails on another computer

Fonts and smoothing differ between operating systems, so each baseline is for one system. The file name shows it, such as `cart@default-darwin.png`. The first check on a new system saves a new baseline.

A visual check also fails when a part of the page changes on every load, such as a date or an ad. Use `mask` with a selector for that part.

## An exported script fails

- Install the browser package that the first lines of the script name: `npm install --save-dev puppeteer`, or `puppeteer-core` for a script that uses the installed Chrome.
- Set `BASE_URL` when the app runs at another address, and set the secrets that the script lists.
- A line that starts with `// Fix by hand` had no stable selector. Add a selector for that element.
- With `VIDEO`, the script needs ffmpeg. Set `FFMPEG_PATH`, or install ffmpeg.
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
