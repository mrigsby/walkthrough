# Tools

The `uiwalk` MCP server has 29 tools. In Claude Code, the skill and the slash commands use them for you. You can also ask for a tool by name.

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

Shows console messages, page errors, and failed requests. By default, it shows errors and warnings since the current step started. `since` shows the entries after a marker number, and `levels` picks `error`, `warning`, or `info`.

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

The reply starts with `status:` and then `pass`, `bug`, `skip`, `stop`, `waiting`, `use_chat`, or `canceled`. On `bug`, Walkthrough saves a screenshot and the errors from the step.

## Test plans and runs

### `plan`

With `action`: `list` the plans, `show` one, `validate` one by `name` or by `content`, or `save` new `content` with a `name`. `overwrite: true` replaces a plan.

### `run_start`

Starts a run from a `plan`, or an ad hoc run with a `name`. `mode` is `interactive`, `checkpoints`, or `autonomous`. It opens the browser at the start page and lists the steps.

### `run_step`

Records a step that the agent checked: `status` is `pass`, `fail`, `skip`, or `blocked`. Give `stepId` (or `step` or `title`), and `actual` for a failure. On a failure, it saves a screenshot and the errors.

### `run_finish`

Finishes the run and writes `report.md` and `report.html`. `summary` goes at the top of the report. With `runId`, it writes an older run's reports again.

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

## Record and share

### `record`

Records you as you use the app. `action` is `start` (with a `name`), `wait` (until you click **Stop recording**), `stop`, or `status`. When recording stops, the reply has a YAML plan draft.

### `export_script`

Writes a Puppeteer script from a finished run to `.walkthrough/exports/`. `runId` picks the run. `installedChrome: true` uses `puppeteer-core` and the installed Chrome.

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
