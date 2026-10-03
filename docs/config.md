# Settings

Walkthrough reads its settings from two files in `.walkthrough/`:

- `config.yaml` holds the settings for the whole team. Commit it.
- `config.local.yaml` holds your own settings. Git does not track it. Its values replace the values in `config.yaml`.

Both files are optional. Walkthrough reads them again each time it opens the browser.

## Example

```yaml
baseUrl: http://localhost:3000
allowedOrigins:
  - http://localhost:3000
  - https://*.staging.example.com
vars:
  shopper: Demo Shopper
environments:
  staging:
    baseUrl: https://staging.example.com
    vars: { shopper: Staging Shopper }
  production:
    baseUrl: https://www.example.com
dialogs: ask
panel: true
highlightMs: 600
browser:
  headless: false
  slowMo: 0
accessibility:
  standard: wcag22aa
  checks: { keyboard: true, darkMode: true, reflow: true, frames: true, screenshots: true }
video:
  runFormat: mp4
  bugFormat: gif
lighthouse:
  device: desktop
  categories: [performance, best-practices, seo]
```

## Settings for `config.yaml`

| Setting | Default | What it does |
| --- | --- | --- |
| `baseUrl` | none | The start page of the development environment, for `browser_open` and test runs. A plan can set its own. |
| `allowedOrigins` | `http://localhost:*`, `http://127.0.0.1:*`, `https://localhost:*` | The sites that Walkthrough may open, in every environment. It blocks all other sites, also after a click. Use `*` for any port or any subdomain. A list here replaces the default list. The site of the base URL of the environment in use is always allowed. |
| `environments` | none | Other copies of the app, such as `staging` and `production`, each with its own `baseUrl`. See [Environments](environments.md). |
| `environment` | `development` | The environment to use when nothing else chooses one. `config.local.yaml` can set your own default. |
| `vars` | none | Values for `{{var:NAME}}` in plans, such as `{ shopper: Demo Shopper }`. Plans and environments can change them. |
| `dialogs` | `ask` | How to answer confirm and prompt dialogs: `ask` (the agent asks you), `accept`, or `dismiss`. Walkthrough always accepts alerts. |
| `panel` | `true` | Show the Pass, Bug, Skip, and Stop panel in the browser. |
| `highlightMs` | `600`, or `0` when the browser is hidden | How long a box shows on an element before the agent uses it. |
| `askTimeoutSec` | `300` in Claude Code, `50` in other clients | How long the agent waits for your answer in the panel before it waits again. From 10 to 3600. |
| `actionTimeoutMs` | `10000` | How long an action waits for its element. From 1000 to 120000. |
| `browser.headless` | `false` | `true` hides the browser. With a hidden browser there is no panel, so the agent asks in the chat. |
| `browser.slowMo` | `0` | Milliseconds to wait between browser steps, so you can watch each one. Up to 5000. |
| `browser.executablePath` | none | The path to a Chrome that Walkthrough uses instead of the installed Chrome. |

### Accessibility

These settings are for accessibility checks and reports. See [Accessibility reports](accessibility.md).

| Setting | Default | What it does |
| --- | --- | --- |
| `accessibility.standard` | `wcag22aa` | The standard to check: `wcag2a`, `wcag2aa`, `wcag21aa`, or `wcag22aa`. |
| `accessibility.bestPractices` | `true` | Also check axe-core best practices. They do not change the WCAG score. |
| `accessibility.checks` | all `true` | The extra checks for a scan: `keyboard`, `darkMode`, `reflow`, `frames`, and `screenshots`. |
| `accessibility.maxScreenshots` | `25` | The most screenshots of problems for each page. From 0 to 200. |

`config.local.yaml` can change one check, such as `accessibility: { checks: { screenshots: false } }`. The other checks keep their values.

### Video

These settings are for videos and GIFs. See [Videos](video.md).

| Setting | Default | What it does |
| --- | --- | --- |
| `video.runFormat` | `mp4` | The default video format: `mp4`, `webm`, or `gif`. It applies to whole runs, the `video` tool, and replays. |
| `video.bugFormat` | `gif` | The format for the short clips saved with bugs. |
| `video.width` | `1280` | The width of MP4 and WebM videos, in pixels. From 320 to 3840. |
| `video.gifWidth` | `800` | The width of GIFs, in pixels. From 200 to 1920. |
| `video.gifFps` | `10` | Frames per second in GIFs. From 1 to 30. |
| `video.maxGifSeconds` | `60` | The longest GIF, in seconds. Use MP4 or WebM for longer videos. |
| `video.idleSeconds` | `1` | Walkthrough shortens each wait, such as the agent thinking, to this many seconds. |
| `video.replaySeconds` | `15` | How many seconds a bug clip shows. `0` turns bug clips off. |
| `video.showPanel` | `false` | Show the Walkthrough panel in videos. |
| `video.pointer` | `true` | Draw the mouse pointer and a mark for each click. |
| `video.captions` | `true` | Show step titles at the bottom of the video. |

`config.local.yaml` can change one video setting. The others keep their values.

### Lighthouse

These settings are for Lighthouse reports and for plans with Lighthouse steps. A plan's `lighthouse` block wins over them. See [Lighthouse reports](lighthouse.md).

| Setting | Default | What it does |
| --- | --- | --- |
| `lighthouse.device` | `desktop` | Test as a `desktop` or a `mobile` device. |
| `lighthouse.categories` | `[performance, best-practices, seo]` | The report categories. You can also add `accessibility` and `agentic-browsing`. |

## Settings only for `config.local.yaml`

These settings can harm your data or your secrets. Walkthrough ignores them in `config.yaml`, so a change that someone else commits cannot turn them on for you. `/walkthrough:doctor` warns you if they are in the wrong file.

| Setting | Default | What it does |
| --- | --- | --- |
| `allowEvaluate` | `false` | Turn on the `evaluate` tool, which runs JavaScript in the page. |
| `uploadsRoot` | the project folder | The folder that uploads can come from. Walkthrough never uploads hidden files, `.env`, or saved logins. |
| `screenshotRoots` | none | A list of folders outside the project where screenshots and videos can go with `path`. Example: `[../website/static/images]`. |
| `allowSecretValues` | `false` | Show the values of cookies, storage items, and login headers in tool replies. When it is off, replies show a short fingerprint instead of the value. |
| `ffmpegPath` | none | The ffmpeg program to use for videos. Without it, Walkthrough uses `UIWALK_FFMPEG`, then an ffmpeg on the `PATH`, then the copy from `uiwalk setup ffmpeg`. |

## Secrets

Put passwords and other secrets in `.walkthrough/.env`:

```sh
APP_PASSWORD=your-password
API_TOKEN=abc123
```

Then use them as `{{secret:APP_PASSWORD}}` in chat or in plans. Walkthrough puts the value into the field, and it shows `****` to the agent. If a name is not in `.env`, Walkthrough uses an environment variable with that name.

Each environment can have its own file with the same names, such as `.walkthrough/.env.staging`. Walkthrough reads that file first. A protected environment, such as production, never reads the plain `.env`. See [Secrets](environments.md#secrets).

Walkthrough also hides these values if they appear on a page, in a log, or in a report.

## Environment variables

| Variable | What it does |
| --- | --- |
| `UIWALK_PROJECT_DIR` | The project folder. Use it when a client does not tell the server which folder is open. |
| `UIWALK_HEADLESS` | `1` hides the browser. `0` shows it. It replaces `browser.headless`. |
| `UIWALK_LOG_LEVEL` | `debug`, `info` (default), `warn`, or `error`. The server writes logs to stderr. |
| `UIWALK_CACHE_DIR` | Where `uiwalk setup` saves Chrome for Testing, Lighthouse, and ffmpeg. The default is `~/.cache/uiwalk`. |
| `UIWALK_FFMPEG` | The ffmpeg program to use, when `ffmpegPath` is not set. |
| `UIWALK_TRACE_FILE` | A file path. The server writes one JSON line for each action, for debugging. |
| `UIWALK_ENV` | The environment that the session starts with, such as `staging`. |
| `UIWALK_ALLOW_PROTECTED` | Protected environments that need no question before Walkthrough works there, such as `production`. For automation only. |

The tests use three more variables. `UIWALK_FORCE_PANEL` shows the panel in a hidden browser. `UIWALK_DEBUG_ENDPOINT_FILE` names a file for the address of the test Chrome. `UIWALK_SCAN_LIMIT_MS` sets the time limit of one `a11y_scan` call. Do not use them for normal testing.

## How Walkthrough finds the project folder

Walkthrough uses the first one of these that it finds:

1. The `projectDir` value of a tool call.
2. The `UIWALK_PROJECT_DIR` variable.
3. The `CLAUDE_PROJECT_DIR` variable, which Claude Code sets.
4. The first folder that the client shares with the server (MCP roots).
5. The folder that the server started in.

`/walkthrough:doctor` shows the folder and how Walkthrough found it.

## Files that Git does not track

`/walkthrough:init` makes `.walkthrough/.gitignore` with these lines:

```text
.env
.env.*
!.env.example
sessions/
runs/
config.local.yaml
```

`.env.*` keeps the secret files of each environment out of Git, such as `.env.staging`. In a project from an older version, run `/walkthrough:init` again to add it.
