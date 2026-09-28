# Tools

The `uiwalk` MCP server has 36 tools. In Claude Code, the skill and the slash commands use them for you. You can also ask for a tool by name.

Text that comes from a web page shows between `<page-content>` tags. The agent treats that text as data, not as instructions.

## Browser

### `browser_open`

Opens a visible Chrome at the start page, or connects to a Chrome that is already running.

| Parameter | What it does |
| --- | --- |
| `url` | The page to open. A full URL, or a path such as `/login` when `baseUrl` is set. |
| `attach` | Connect to a running Chrome, such as `http://127.0.0.1:9222`. See [Troubleshooting](troubleshooting.md#connect-to-your-own-chrome). |
| `session` | A saved login to use. |
| `projectDir` | The project folder, if Walkthrough cannot find it. |

### `browser_close`

Closes the test browser. If Walkthrough connected to your own Chrome, it disconnects and leaves Chrome open.

### `navigate`

Goes to a `url` or a path, or does `back`, `forward`, or `reload` with `action`. Walkthrough opens only the allowed sites.

### `tabs`

Lists, opens, switches, and closes tabs. Other tools work on the active tab.

| `action` | What it does |
| --- | --- |
| `list` | Lists the tabs with their id, name, login, and settings. This is the default. |
| `new` | Opens a new tab. It becomes the active tab. |
| `switch` | Makes a tab the active tab. |
| `close` | Closes a tab. |

| Parameter | What it does |
| --- | --- |
| `id` | For `switch` and `close`: a tab id such as `t2`, a tab name, or `newest` for the tab that opened last. |
| `url` | For `new`: the page to open. |
| `name` | For `new` and `switch`: a name for the tab, such as `customer`. Plans use names. |
| `isolated` | For `new`: `true` gives the tab a new login of its own, with its own cookies and storage, like a private window. A name, such as `customer`, gives it a login that other tabs with the same name share. Without it, the tab uses the main login. |
| `session` | For `new`: a saved login to load into the tab. |

Use a separate login to test two users at the same time, such as an admin and a customer. In a visible Chrome, a separate login opens in its own window. A tab that a page opens, such as a link with `target="_blank"`, gets the login and the settings of the tab that opened it. A separate login ends when its last tab closes.

### `dialog`

Answers an alert, confirm, or prompt dialog with `accept` or `dismiss`. Give `text` for a prompt. With `action: policy`, it sets how to answer the next dialogs: `ask`, `accept`, or `dismiss`.

## Page

### `snapshot`

Gives an outline of the page: headings, links, buttons, fields, and text. Each element has a ref, such as `e12`. With `ref`, it outlines only that part. A ref from an old snapshot stops working when the page changes.

### `act`

Does one action on an element, by `ref` or by `selector`.

| `action` | Uses |
| --- | --- |
| `click`, `dblclick`, `hover` | the element |
| `fill` | `value`, the text to type. Use `{{secret:NAME}}` for secrets, and `{{unique}}` for a value that is new in each run. |
| `select` | `value`, the option text or value |
| `check`, `uncheck` | the check box or radio button |
| `press` | `value`, a key such as `Enter` or `Control+A`. The element is optional. |
| `scroll` | the element, or `value`: `up`, `down`, or a number of pixels |
| `upload` | `files`, paths in the project folder |

If an action opens a dialog, the reply says `dialog_pending`.

### `wait_for`

Waits for one thing: `text` to show, `textGone`, a `selector` to be visible, the `url` to contain a value, `networkIdle`, or `ms` milliseconds. `timeoutMs` is 10000 by default.

### `read`

Reads one element, by `ref` or `selector`: its text, its value, and if it is visible, enabled, or checked.

### `screenshot`

Saves a PNG and returns a small preview. By default, the file goes in the run folder, or in a folder for today when no run is going.

| Parameter | What it does |
| --- | --- |
| `ref`, `selector` | Capture only this element. |
| `annotate` | With `ref` or `selector`: capture the page with a red box on the element. |
| `fullPage` | Capture the whole page. |
| `label` | A short name for the file. |
| `path` | Save to this exact file, such as `docs/images/help/cart.png`, and replace the file if it exists. Use `.png`, `.jpg`, `.jpeg`, or `.webp`. The file must be in the project folder, and not in a hidden folder. `screenshotRoots` in `config.local.yaml` can allow other folders. |
| `stepId` | During a run: add the screenshot to this step. With `path`, an [exported script](sharing.md#make-screenshots-again) saves the same file again. |

### `logs`

Shows console messages, page errors, failed requests, and Chrome issues. By default, it shows errors and warnings since the current step started. `since` shows the entries after a marker number, `levels` picks `error`, `warning`, or `info`, and `kinds` picks `console`, `page-error`, `network`, or `issue`.

Chrome issues are the problems that the Issues panel in DevTools shows. They include cookies that Chrome blocked, Content Security Policy and CORS blocks, and mixed content. They also include deprecated features and form problems, such as a label that points to a missing id. Anything that Chrome blocked is an error. Each issue shows once in each step.

### `network`

Lists the requests of the browser, like the Network panel in DevTools. By default, it lists page, XHR, and fetch requests since the current step started. Each request has an id, such as `r12`.

| Parameter | What it does |
| --- | --- |
| `action` | `list` (the default), `show` one request with its headers and body, or `har` to save the requests as a HAR file. |
| `id` | For `show`: the request id. |
| `urlContains` | Only requests whose address has this text. |
| `types` | Resource types, such as `["xhr", "fetch"]`. `all: true` lists every type, also scripts, styles, and images. |
| `status` | A status such as `500` or `4xx`. `errors` means 400 and up, or failed. `failed` means the request got no answer. |
| `since` | Requests after this marker number. `0` means all requests that Walkthrough still has. |
| `limit` | For `list`: the most requests to show. The default is 50. |
| `name`, `stepId` | For `har`: a short name for the file, and a run step to add the file to. |

Walkthrough keeps the bodies of page, XHR, and fetch responses with text, up to 256 KB each. Login headers such as `Authorization` and `Cookie`, and body fields such as `password` and `token`, show as a fingerprint unless `allowSecretValues` is on. HAR files always remove them, because you share HAR files. DevTools and other tools can open a HAR file.

### `intercept`

Answers requests with your own data, blocks them, or delays them. Use it to test error states, empty states, and slow answers without changing the server.

| Parameter | What it does |
| --- | --- |
| `action` | `list` the rules (the default), `add` a rule, `remove` one rule by `id`, or `clear` all rules. |
| `url` | The address to match. A path such as `/api/stock` matches that path on any site. Add `?` to match the query too. A full address or a pattern with `*`, such as `*/images/*`, matches the whole address. |
| `urlRegex` | A regular expression for the whole address, instead of `url`. |
| `method`, `type`, `tab` | Match only this method (`POST`), this resource type (`fetch`, `xhr`, `document`, `image`), or this tab (a name or an id). |
| `status`, `json`, `body`, `headers`, `contentType` | The answer. `json` sends JSON. `body` sends text. |
| `block` | Fail the request, as if the network blocked it. |
| `delayMs` | Wait this long, then send the request on, or send the answer. |
| `times` | Use the rule this many times, then stop. |

The first rule that matches wins. Rules apply to every tab, also tabs that open later, until you clear them or the browser closes. While rules exist, the browser cache is off, so every request reaches the rules. The guard for allowed sites runs first, so a rule never opens a site that is not allowed.

In a run, a step that used a rule shows a **Mocked** badge in the report, so a pass with fake data does not look like a real pass.

### `inspect`

Shows why an element looks and acts the way it does, like the Elements panel in DevTools. Give a `ref` or a `selector`.

The reply has the box size with the padding, border, and margin, and some computed styles. It also has the CSS rules that apply, with their file and line, and the event listeners, with their script, line, and column. `properties` picks other computed styles. `rules: false` or `listeners: false` omits that part. By default, it also shows listeners on the parents, the document, and the window (`ancestors`), because many frameworks put one handler on the root.

It works on the page and on frames from the same site. The files and lines are those that the browser loaded. Walkthrough does not follow source maps.

### `evaluate`

Runs a JavaScript expression in the page. It is off unless `allowEvaluate: true` is in `config.local.yaml`.

## You and the agent

### `ask_developer`

Shows a step in the panel and waits for your answer.

| Parameter | What it does |
| --- | --- |
| `title` | A short name for the step. |
| `didWhat` | What the agent did. |
| `expected` | What you should see. |
| `step`, `total`, `stepId` | The step number, the number of steps, and the step id in a plan. |
| `resume` | Keep waiting for the question that is already in the panel. |

The reply starts with `status:` and then `pass`, `bug`, `skip`, `stop`, `waiting`, `use_chat`, or `canceled`. On `bug`, Walkthrough saves a screenshot, the errors from the step, and a HAR file with the network requests of the step. During a run, it also saves a video of the last seconds before the bug. See [Bug clips](#bug-clips).

## Test plans and runs

### `plan`

With `action`: `list` the plans, `show` one, `validate` one by `name` or by `content`, or `save` new `content` with a `name`. `overwrite: true` replaces a plan.

### `run_start`

Starts a run from a `plan`, or an ad hoc run with a `name`. `mode` is `interactive`, `checkpoints`, or `autonomous`. It opens the browser at the start page and lists the steps. `video: true` records the whole run as a video, like the plan's `video` key.

### `run_step`

Records a step that the agent checked: `status` is `pass`, `fail`, `skip`, or `blocked`. Give `stepId` (or `step` or `title`), and `actual` for a failure. On a failure, it saves a screenshot, the errors, a HAR file with the network requests of the step, and a video of the last seconds. See [Bug clips](#bug-clips).

### `run_finish`

Finishes the run and writes `report.md` and `report.html`. `summary` goes at the top of the report. With `runId`, it writes an older run's reports again. When the run records a video, `run_finish` saves it first as `video/run.<format>` in the run folder, and the report plays it.

### `runs`

Lists recent runs with their results. `limit` is 10 by default.

## More checks

### `emulate`

Changes the settings of the active tab. With `allTabs: true`, it changes every tab and the tabs that open later. Without settings, it shows the settings of the active tab.

| Parameter | What it does |
| --- | --- |
| `device` | `desktop`, `laptop`, `tablet`, `mobile`, `default`, or a Puppeteer device name such as `Pixel 5`. |
| `colorScheme` | `light`, `dark`, or `system`. |
| `network` | `normal`, `slow-3g`, `fast-3g`, `slow-4g`, `fast-4g`, or `offline`. |
| `cpu` | Makes the CPU slower by this factor, such as `4`. `1` is normal speed. |
| `timezone` | A time zone such as `Europe/Berlin`, or `system`. |
| `locale` | A language and region such as `de-DE`, or `system`. It changes date and number formats and the `Accept-Language` header. |
| `geolocation` | A place such as `{ latitude: 52.52, longitude: 13.4 }`. It also allows location for the login. `off` blocks location. |
| `reducedMotion` | `reduce`, `no-preference`, or `system`. |
| `media` | `screen` or `print`. |
| `permissions` | `{ geolocation, notifications, clipboard }`, each `grant`, `deny`, or `prompt`. |
| `allTabs` | Change every tab, and the tabs that open later. |

Permissions belong to a login, so they apply to every tab of the same login.

### `session`

With `action`: `save` the login of the active tab with a `name`, `list` the saved logins, or `delete` one. `browser_open`, `tabs` (action `new`), and plans can load a saved login.

### `storage`

Reads and changes cookies, `localStorage`, and `sessionStorage` of the sites under test, in the login of the active tab. It never touches other sites.

| `action` | What it does |
| --- | --- |
| `list` | Lists the cookies (or the storage items) with their flags. |
| `get` | Shows one cookie or item, by `name`. |
| `set` | Sets a cookie or item: `name` and `value`. For cookies, also `domain`, `path`, `expires` (Unix seconds), `httpOnly`, `secure`, and `sameSite`. |
| `delete` | Deletes one cookie or item, by `name`. |
| `clear` | Deletes all cookies of the sites under test, or all items. |
| `check` | Checks cookies: `checks`, such as `[{ name: session, httpOnly: true }]`, or the `stepId` of a plan step with `cookies`. The reply starts with `result: pass` or `result: fail`. |
| `clearSiteData` | Clears the cookies, storage, cache, IndexedDB, and service workers of the active tab's site. |

`kind` is `cookies` (the default), `local`, or `session`. A check can have `name`, `exists`, `value`, `contains`, `httpOnly`, `secure`, and `sameSite`.

Values often hold logins, so the reply shows a fingerprint such as `**** (36 characters, id 3f2a)`. The same value always has the same id. To see the values, set `allowSecretValues: true` in `config.local.yaml`. Checks compare the values without showing them.

### `visual_check`

Compares the page, or one element (`ref` or `selector`), with a baseline screenshot. The first check saves the baseline.

| Parameter | What it does |
| --- | --- |
| `name` | A name for the check, such as the step id. Required. |
| `fullPage` | Compare the whole page. |
| `mask` | Selectors for parts that change on every load, such as dates. |
| `maxDiffPercent` | How much can change, in percent of pixels. The default is 0. |
| `updateBaseline` | Save this screenshot as the new baseline. |
| `stepId` | During a run, add the images to this step. |

The reply starts with `result:` and then `created`, `match`, `mismatch`, or `updated`.

## Accessibility

See [Accessibility reports](accessibility.md) for the whole flow.

### `a11y_audit`

Checks the current page with axe-core, or one part of it. The reply groups the problems by impact and names the WCAG criteria. Extra checks run only when you ask for them.

| Parameter | What it does |
| --- | --- |
| `ref`, `selector` | Check one part of the page. |
| `standard` | `wcag2a`, `wcag2aa`, `wcag21aa`, or `wcag22aa`. The default comes from `config.yaml`. |
| `tags` | axe-core rule groups, such as `["wcag2a", "wcag2aa"]`. They replace `standard`. |
| `checks` | Extra checks: `keyboard`, `darkMode`, `reflow`, `frames`, `screenshots`. |
| `stepId` | During a run, add the results to this step and the report. For a plan step with `a11y`, the checks come from the plan. |

### `a11y_scan`

Checks one page or a list of pages (`urls`) with axe-core and the checks from `config.yaml`. Without a run, it makes a run with one step per page, and writes `report.md` and `report.html`. During a run, it adds the pages as steps.

A scan stops after about 45 seconds. The reply then says to call it again with `runId`. `session` loads a saved login first. `standard` and `checks` replace the settings.

### `a11y_report`

Writes the accessibility report of a run. It has two calls:

1. Without `items`, it returns the findings with IDs, the scores, a `digest`, and how to write the text.
2. With `digest`, `summary`, and `items`, it writes `accessibility.html`, `accessibility.md`, and `accessibility.json`. Each item has `id`, `explain`, `fix`, and an optional `code` and `where`. The reply has a prompt for the next session.

`runId` picks the run. The default is the run that is going, or the newest run with accessibility results. `compareTo` picks the report to compare with.

## Lighthouse

Lighthouse is an optional download. Install it with `npx -y walkthrough-ui setup lighthouse`. See [Setup](#setup).

### `lighthouse`

Checks pages with Lighthouse, like the Lighthouse panel in DevTools. During a run, it also measures the steps of a user flow.

| Parameter | What it does |
| --- | --- |
| `action` | `audit` (the default) checks pages. `navigate`, `start`, `end`, and `snapshot` measure flow steps. `status` shows whether Lighthouse is installed. |
| `urls` | The pages to check. The default is the current page. For `navigate`, the page to load when the step has no `navigate` action. |
| `stepId` | For flow actions: the plan step that Lighthouse measures. |
| `device` | `desktop` or `mobile`. The default comes from `config.yaml`. |
| `categories` | `performance`, `accessibility`, `best-practices`, `seo`, and `agentic-browsing`. The default comes from `config.yaml`. |
| `runId`, `name`, `session` | Continue a check that stopped, name the new run, or use a saved login for the checks. |

With `audit`, each page runs in its own hidden Chrome with an empty profile. Walkthrough copies the login of the active tab into it, so the page stays logged in. Chrome remembers things between pages, such as its cache and failed favicons. A new Chrome for each page gives each check the same start. That Chrome has no Walkthrough panel and no screen or network settings from Walkthrough. Mock rules for all tabs still apply. The test browser does not have to be open. Without a run, it makes a run with one step per page. Lighthouse's own reports go in the `lighthouse/` folder of the run. A call stops after about 45 seconds, and the reply says to call it again with `runId`.

The flow actions work only during a run, in the active tab:

- `navigate`: Lighthouse loads the page of the step's `navigate` action, and measures the load.
- `start` and `end`: Lighthouse measures what happens between the two calls.
- `snapshot`: Lighthouse checks the page as it is.

The tab keeps its screen size and settings, and Walkthrough hides its panel while Lighthouse measures. The settings come from the plan's `lighthouse` block, or from `config.yaml`. After each step, Walkthrough writes Lighthouse's flow report to `lighthouse/flow.report.html`. See [Lighthouse flows](plan-format.md#lighthouse-flows).

### `lighthouse_report`

Writes the Lighthouse report of a run in two calls, like `a11y_report`:

1. Without `items`, it returns the scores, the findings with IDs such as `LH-001`, a `digest`, and how to write the text.
2. With `digest`, `summary`, and `items`, it writes `lighthouse.html`, `lighthouse.md`, and `lighthouse.json`. Each item has `id`, `explain`, `fix`, and an optional `code` and `where`.

A new report compares itself with the last report of the same pages. A flow report compares itself with the last report of the same plan. Issues keep their IDs, and the report shows the changes in page load scores. `compareTo` picks the report to compare with.

## Record and share

### `video`

Records the active tab as a video. The video follows the active tab to other tabs.

| Parameter | What it does |
| --- | --- |
| `action` | `start` begins recording. `caption` sets the text at the bottom. `stop` saves the video. `status` shows what is recording. `slideshow` makes a video of the screenshots of a run. `replay` records a finished run again. |
| `name` | A name for the file, such as `checkout`. |
| `text` | For `caption`: the text. An empty text removes the caption. |
| `format` | For `stop` and `slideshow`: `mp4`, `webm`, or `gif`. The default comes from the `path`, then from `video.runFormat` in `config.yaml`. A slideshow is a GIF by default. |
| `path` | For `stop` and `slideshow`: also save the video to this file, such as `docs/images/cart.gif`. The same rules as screenshot paths apply. |
| `showPanel` | For `start`: show the Walkthrough panel in the video. |
| `runId` | For `slideshow` and `replay`: the run. The default is the run that is going, or the newest run. |
| `pace`, `session`, `captions`, `pointer`, `titleCard`, `width` | For `replay`. See [Clean re-recordings](#clean-re-recordings). |

- Walkthrough cuts each wait, such as the agent thinking, to `video.idleSeconds` (1 second). It cuts the time that a question waits in the panel.
- The video draws the mouse pointer and marks each click. Captions show at the bottom. During a run, the captions are the step titles, or the step's `caption` key.
- Walkthrough hides the panel while it records. It hides a field before the agent types a secret into it.
- A hidden Chrome encodes the video. MP4 needs a Chrome that can make H.264. Without it, Walkthrough makes WebM and converts it with ffmpeg. When ffmpeg is missing, the video stays WebM, and the reply gives the install command.
- A GIF can be up to `video.maxGifSeconds` long (60 seconds). For a longer one, `stop` refuses and keeps the recording, so you can call `stop` again with `mp4` or `webm`.
- Without a run, videos go in `.walkthrough/runs/adhoc-<day>/video/`. During a run, they go in the `video/` folder of the run, and the report shows them.
- A slideshow starts with a title card that shows the run name. Then it shows each screenshot of the run for 2 seconds, with the step title as the caption. It goes in `video/slideshow.<format>`.

#### Clean re-recordings

`video` with action `replay` records a finished run again, for a clean demo video. It does not make a new run.

- It opens a new login in a new window, so it starts with no cookies and no storage. `session` loads a saved login first. The default is the saved login of the run.
- It uses the run's screen and settings. Without a device, the page is `width` pixels wide (1280) at 16:10.
- It types text one character at a time, moves the pointer to each element, and holds at the end of each step. `pace` is `slow`, `normal` (the default), or `fast`.
- It makes a new `{{unique}}` value, answers dialogs like the run did, and hides typed secrets.
- A title card with the run name comes first. `titleCard: false` leaves it out. `captions: false` and `pointer: false` leave those out.
- `format` and `path` take a list, such as `format: [mp4, gif]`. The files go in the `video/` folder of the run as `<time>-replay.<format>`, and the report shows them.
- When a step does not work, the replay stops. The reply names the step and has a screenshot. Walkthrough saves no video then.
- Walkthrough cannot replay a run with an action that has no stable selector. Add an exact `action` to that plan step, and run the plan again.

#### Bug clips

During a run, Walkthrough keeps the last 3 minutes of the active tab in a temp folder. When a step fails or is blocked, or you mark a bug in the panel, Walkthrough cuts the wait time from those minutes. It then saves the last `video.replaySeconds` (15) seconds as `video/bug-<step>.<format>`. The format comes from `video.bugFormat` (GIF). The step card in the report shows the clip, and `issue_draft` lists it with the other files.

- The panel stays in bug clips, because you use it during the run. Walkthrough hides typed secrets.
- A run that records a whole video gets its bug clips from that video.
- `video.replaySeconds: 0` turns bug clips off. Walkthrough then keeps nothing.

### `record`

Records you as you use the app. `action` is `start` (with a `name`), `wait` (until you click **Stop recording**), `stop`, or `status`. When recording stops, the reply has a YAML plan draft.

### `export_script`

Writes a Puppeteer script from a finished run to `.walkthrough/exports/`. `runId` picks the run. `installedChrome: true` uses `puppeteer-core` and the installed Chrome. `VIDEO=<file>` records a video when the script runs, and `PACE_MS` waits before each browser action. See [Make a video again](sharing.md#make-a-video-again).

### `issue_draft`

Writes a GitHub issue title and body from a bug or a failed step. `runId` and `stepId` pick the step. It saves the body to a file and lists the screenshots. It does not create the issue.

## Setup

### `init_project`

Makes the `.walkthrough` folder with `config.yaml`, a sample plan, the plan schema, `.env.example`, and `.gitignore`. `baseUrl` sets the start page. It keeps files that exist.

### `doctor`

Checks Node, Chrome, the project folder, the settings, the secrets, Lighthouse, and ffmpeg. Each line starts with `OK`, `INFO`, or `FIX`.

Lighthouse and ffmpeg are optional downloads. Install them from a terminal:

```sh
npx -y walkthrough-ui setup lighthouse   # about 170 MB, installed with npm
npx -y walkthrough-ui setup ffmpeg       # checks the SHA-256 hash of the download
```

Both go in `~/.cache/uiwalk`. When Walkthrough runs from the plugin, the reply of a tool that needs one of them shows the exact command.
