# Walkthrough tools

All tools come from the `uiwalk` MCP server.

## Browser

| Tool | Use it to |
|---|---|
| `browser_open` | Open Chrome at the start page or a `url`. With `attach`, connect to a Chrome that is already running. |
| `browser_close` | Close the test browser, or disconnect from the developer's Chrome. |
| `navigate` | Go to a `url` or a path, or go `back`, `forward`, or `reload`. |
| `tabs` | List tabs, `switch` to a tab, or `close` a tab. |
| `dialog` | Answer an alert, confirm, or prompt dialog: `accept` or `dismiss`. Or set the dialog `policy`. |

## Page

| Tool | Use it to |
|---|---|
| `snapshot` | Get an outline of the page with refs, such as `e12`. With `ref`, outline one part. |
| `act` | Do one action on a ref or selector: click, dblclick, hover, fill, select, check, uncheck, press, scroll, upload. |
| `wait_for` | Wait for `text`, `textGone`, a `selector`, a `url`, `networkIdle`, or `ms`. |
| `read` | Read the text, value, and state of one element. |
| `screenshot` | Save a screenshot. With a ref and `annotate: true`, draw a red box around the element. |
| `logs` | See console errors, page errors, and failed requests. |
| `evaluate` | Run page JavaScript. It is off unless the developer turns it on in `config.local.yaml`. |

## Developer and runs

| Tool | Use it to |
|---|---|
| `ask_developer` | Show a step in the browser panel and wait for Pass, Bug, Skip, or Stop. |
| `plan` | `list`, `show`, `validate`, or `save` test plans. |
| `run_start` | Start a run from a plan, or an ad hoc run with a `name`. |
| `run_step` | Record a step that you checked yourself: `pass`, `fail`, `skip`, or `blocked`. |
| `run_finish` | Finish the run and write the reports. With `runId`, write an older run's reports again. |
| `runs` | List recent runs. |

## Setup

| Tool | Use it to |
|---|---|
| `init_project` | Make the `.walkthrough` folder with settings and a sample plan. |
| `doctor` | Check Node, Chrome, the project folder, settings, and secrets. |
