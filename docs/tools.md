# Tools

The `uiwalk` MCP server has 27 tools. In Claude Code, the skill and the slash commands use them for you. You can also ask for a tool by name.

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

With `action`: `list` the tabs, `switch` to a tab, or `close` a tab. Give the tab `id`, such as `t2`. Other tools work on the active tab.

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
| `fill` | `value`, the text to type. Use `{{secret:NAME}}` for secrets. |
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

Saves a PNG and returns a small preview.

| Parameter | What it does |
| --- | --- |
| `ref`, `selector` | Capture only this element. |
| `annotate` | With `ref` or `selector`: capture the page with a red box on the element. |
| `fullPage` | Capture the whole page. |
| `label` | A short name for the file. |

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

Sets the `device` (`desktop`, `laptop`, `tablet`, `mobile`, `default`, or a Puppeteer device name such as `Pixel 5`), the `colorScheme` (`light`, `dark`, or `system`), and the `network` (`normal`, `slow-3g`, `fast-3g`, `slow-4g`, `fast-4g`, or `offline`). The settings apply to all tabs.

### `session`

With `action`: `save` the login of the open sites with a `name`, `list` the saved logins, or `delete` one.

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

### `a11y_audit`

Checks accessibility with axe-core, for the page or for one part (`ref` or `selector`). `tags` picks rule groups, such as `["wcag2a", "wcag2aa"]`. During a run, `stepId` adds the results to the report.

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

Checks Node, Chrome, the project folder, the settings, and the secrets. Each line starts with `OK`, `INFO`, or `FIX`.
