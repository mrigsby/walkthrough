# Walkthrough tools

All tools come from the `uiwalk` MCP server.

## Browser

| Tool | Use it to |
| --- | --- |
| `browser_open` | Open Chrome at the start page or a `url`. With `attach`, connect to a Chrome that is already running. |
| `browser_close` | Close the test browser, or disconnect from the developer's Chrome. |
| `navigate` | Go to a `url` or a path, or go `back`, `forward`, or `reload`. |
| `environment` | `list` the environments (development, staging, production, and others), `show` the one in use, or `use` another one. A protected one needs the developer's OK in the browser. |
| `tabs` | List tabs, open a `new` tab, `switch` to a tab, or `close` a tab. `isolated: true` gives a new tab its own login (a second user). `isolated: "name"` gives it a login that tabs share. |
| `dialog` | Answer an alert, confirm, or prompt dialog: `accept` or `dismiss`. Or set the dialog `policy`. |

## Page

| Tool | Use it to |
| --- | --- |
| `snapshot` | Get an outline of the page with refs, such as `e12`. With `ref`, outline one part. |
| `act` | Do one action on a ref or selector: click, dblclick, hover, fill, select, check, uncheck, press, scroll, upload. |
| `wait_for` | Wait for `text`, `textGone`, a `selector`, a `url`, `networkIdle`, or `ms`. |
| `read` | Read the text, value, and state of one element. |
| `screenshot` | Save a screenshot. With a ref and `annotate: true`, draw a red box around the element. With `path`, save to that exact file. With `stepId`, add it to a run step. |
| `logs` | See console errors, page errors, failed requests, and Chrome issues (blocked cookies, CSP, CORS, form problems). `kinds` filters them. |
| `network` | List requests (page, XHR, fetch) since the step started. `show` one request with its headers and body. `har` saves a HAR file. |
| `intercept` | `add` a rule that answers requests with your data (`status`, `json`, `body`), blocks them, or delays them. `list`, `remove`, or `clear` rules. |
| `inspect` | Show an element's computed styles, box, CSS rules (file and line), and event listeners (file and line). |
| `evaluate` | Run page JavaScript. It is off unless the developer turns it on in `config.local.yaml`. |

## More checks

| Tool | Use it to |
| --- | --- |
| `emulate` | Set the active tab's `device`, `colorScheme`, `network`, `cpu`, `timezone`, `locale`, `geolocation`, `reducedMotion`, `media`, or `permissions`. `allTabs: true` sets every tab. |
| `session` | `save`, `list`, or `delete` saved logins. |
| `storage` | `list`, `get`, `set`, `delete`, or `clear` cookies (or `kind: local` or `session` storage) of the sites under test. `check` checks cookies. `clearSiteData` clears the site's data. Values show as a fingerprint. |
| `visual_check` | Compare the page or one element with a baseline screenshot. |
| `a11y_audit` | Check the current page with axe-core. With `checks`, also run keyboard, dark mode, reflow, frame, and screenshot checks. |
| `a11y_scan` | Check one page or a list of pages, and save the results in a run with `report.html`. |
| `a11y_report` | Get the findings of a run, then write `accessibility.html`, `.md`, and `.json` from your text. |
| `lighthouse` | Check pages with Lighthouse (performance, best practices, SEO), each in its own hidden Chrome with a copy of the login. During a run, `navigate`, `start` and `end`, and `snapshot` measure flow steps in the active tab. `status` shows whether it is installed. |
| `lighthouse_report` | Get the Lighthouse findings of a run, then write `lighthouse.html`, `.md`, and `.json` from your text. |

## Developer and runs

| Tool | Use it to |
| --- | --- |
| `ask_developer` | Show a step in the browser panel and wait for Pass, Bug, Skip, or Stop. On Bug, it saves a screenshot, a HAR file, and a video of the last seconds. |
| `plan` | `list`, `show`, `validate`, or `save` test plans. |
| `run_start` | Start a run from a plan, or an ad hoc run with a `name`. |
| `run_step` | Record a step that you checked yourself: `pass`, `fail`, `skip`, or `blocked`. On fail or blocked, it saves a screenshot, a HAR file, and a video of the last seconds. |
| `run_finish` | Finish the run and write the reports. With `runId`, write an older run's reports again. |
| `runs` | List recent runs. |

## Record and share

| Tool | Use it to |
| --- | --- |
| `record` | `start` recording the developer, `wait` for Stop, `stop`, or get the `status`. Returns a YAML plan draft. |
| `video` | `start` records the active tab, `caption` sets the text at the bottom, and `stop` saves an MP4, WebM, or GIF (with `format` and `path`). `slideshow` makes a video of a run's screenshots. `replay` records a finished run again in a new login, at an even `pace`, for a clean demo. |
| `export_script` | Write a Puppeteer script from a finished run. |
| `issue_draft` | Write a GitHub issue title and body file from a bug step. |

## Presentations

| Tool | Use it to |
| --- | --- |
| `present` | `start` plays a rehearsal of a plan in an audience window, with a presenter window. `listen` waits for a chat question, a failed step, or the end. `answer` replies to a question (`id`) or sends a note (no `id`). `status` shows where it is. `control` sends a command when the developer asks: `start`, `continue`, `skip`, `retry`, `manual`, `back`, `jump` (with `step`), `blank`, `title`, `presenter` (open the presenter window again), or `end`. `stop` ends it and writes the handout. |

While a presentation is going, only these tools work: `present`, `snapshot`, `read`, `screenshot`, `logs`, `network`, `runs`, `plan`, `issue_draft`, `export_script`, `environment` (not `use`), and `tabs` (action `list`).

## Setup

| Tool | Use it to |
| --- | --- |
| `init_project` | Make the `.walkthrough` folder with settings and a sample plan. |
| `doctor` | Check Node, Chrome, the project folder, settings, environments, secrets, Lighthouse, and ffmpeg. |

`browser_open`, `run_start`, `a11y_scan`, `lighthouse`, `video` (action `replay`), and `present` (action `start`) take `environment`. It switches the session first. `export_script` takes `environment` for the default of the script only.
