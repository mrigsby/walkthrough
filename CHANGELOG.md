# Changelog

This file lists all notable changes to the project.

## 0.2.0 (2026-09-25)

### Added

- The server is on npm as `walkthrough-ui`. Other MCP clients can start it with `npx -y walkthrough-ui`. The command name stays `uiwalk`.
- Screenshots for docs: a plan step can save its screenshot to an exact file, such as `screenshot: docs/images/help/cart.png`, or `{ path, selector, fullPage }`. The plan key `screenshotDir` sets the folder for these paths. Walkthrough checks the paths when a run starts.
- The `screenshot` tool has `path`, to save to an exact file, and `stepId`, to add the screenshot to a run step.
- Exported scripts save these screenshots again and replace the old files. `SHOT=<name>` saves only some of them.
- `screenshotRoots` in `config.local.yaml` lets screenshots go to folders outside the project. Walkthrough never saves them in hidden folders, such as `.git`.
- Accessibility reports: `/walkthrough:a11y` checks one page, a list of pages, or a plan, and writes `accessibility.html`, `accessibility.md`, and `accessibility.json` next to `report.html`. The report has scores, an explanation and a fix for each issue, where to fix it in the source, screenshots, a WCAG criteria table, and a prompt to plan the fixes in a new session.
- New tools `a11y_scan` and `a11y_report`. The server has 29 tools.
- New checks for accessibility: a keyboard walk (traps, focus that you cannot see, elements that Tab cannot reach), contrast in dark mode, reflow at 320 pixels wide, frames on allowed sites, and screenshots of problems.
- A new report compares itself with the last report of the same pages. Issues keep their IDs, and fixed issues are listed.
- Plans can use `accessibility` and the step key `a11y`. `config.yaml` has `accessibility` settings.
- The demo app has more planted accessibility issues, and an `accessibility` plan.

### Changed

- Exported scripts use the screen size and the color scheme of the run. Without a device, the screen is 1280x800, not 800x600.
- `a11y_audit` checks WCAG 2.2 AA and best practices by default, names the WCAG criteria, and saves more data: items that need review, rules that passed, and contrast ratios.
- `report.html` is more accessible: better contrast for badges and links, heading order, and table captions. Step cards show a short accessibility summary.

### Fixed

- Walkthrough refuses a run id that points outside `.walkthrough/runs`.
- Report files and issue drafts hide secrets, also secrets with characters such as `"` or `&`.
- `a11y_audit` refuses a `stepId` when no run is going, or when the plan has no such step.
- `a11y_audit` with a `ref` no longer fails on selectors that only Puppeteer can read.
- Elements inside a shadow root show as `host >>> inner`.
- When two runs start in the same second, Walkthrough finds the newer run. Before, it could open the older run for a report or a comparison. Run IDs now include milliseconds, such as `2026-09-26_003242-123-checkout-ab12`.

## 0.1.0 (2026-09-24)

The first version.

### Added

- CI on GitHub Actions: lint, type check, tests on Linux and macOS, and checks that the bundle and the npm package are up to date.
- The `uiwalk` npm package, with the same bundle as the plugin and no other dependencies. It is not published yet.
- Documentation: a new README, and guides for getting started, settings, tools, safety, sharing with a team and other MCP clients, and troubleshooting.
- Record mode: the `record` tool and `/walkthrough:record` write down your own clicks and typing in the browser, and turn them into a draft plan. Password fields become `{{secret:NAME}}`, and their values never leave the page. The panel can add an expectation or mark the last field as secret.
- The `export_script` tool and `/walkthrough:export` turn a finished run into a plain Puppeteer script. It checks the quoted text and amounts in each `expect`, and it can run in CI.
- The `issue_draft` tool and `/walkthrough:bug` turn a bug into a GitHub issue draft. You see the draft first, and `gh issue create --web` opens the issue page for you to finish.
- Page loads from the `navigate` tool are now part of the run. Steps to reproduce show them, and exported scripts repeat them.
- The `session` tool saves a login (cookies and storage) for the sites under test. `browser_open` and plans can start with it. Saved logins stay on this computer, and only your user account can read them.
- The `emulate` tool tests like a phone, a tablet, or another screen, in light or dark mode, and on slow or no network. Plans can set `device`, `colorScheme`, and `network`.
- The `visual_check` tool compares the page, or one element, with a baseline screenshot and saves a diff image. Masks hide parts that change on every load.
- The `a11y_audit` tool checks accessibility with axe-core, in a place that the page cannot see. Run reports get an "Accessibility" section.
- `UIWALK_TRACE_FILE` writes a trace of each action for debugging.
- Slash commands: `/walkthrough:init`, `/walkthrough:run`, `/walkthrough:plan`, `/walkthrough:report`, and `/walkthrough:doctor`.
- The `init_project` tool and the `uiwalk init` command make the `.walkthrough` folder with settings, a sample plan, and the plan schema.
- The `runs` tool lists recent test runs.
- The skill has reference pages for the plan format, the tools, and bug reports. The build copies the plan format guide into the plugin.
- `npm run check:bundle` fails when the committed bundle does not match the source.
- The snapshot says when a visible image has no alt text, so the agent does not think the image is missing.

- YAML test plans in `.walkthrough/plans`, with a JSON Schema for editor autocomplete. Validation shows the line number of each problem.
- Three run modes: interactive, checkpoints, and autonomous.
- The `plan`, `run_start`, `run_step`, and `run_finish` tools. Each run has its own folder. Walkthrough saves `run.json` after every step.
- A Markdown report and a single-file HTML report for each run, with bugs first and steps to reproduce. A run that ends early still gets a report.
- Sample `checkout` and `login` plans for the demo shop.
- The `uiwalk schema` command.
- A developer panel in the browser. It shows each step with what the agent did and what you should see. You answer Pass, Bug, Skip, or Stop, with notes.
- The panel runs where page scripts cannot see or call it. It accepts only real clicks, and each answer must match the current question.
- The `ask_developer` tool. On Bug, it saves a screenshot with a red box on the last element and the errors from the step.
- The `logs` tool: console messages, page errors, and failed requests. Walkthrough hides tokens in URLs and text.
- A pulsing box shows the element before each action. Screenshots hide the panel and mask typed secrets.
- `screenshot` can draw a red box around one element (`annotate: true`).
- Browser tools: `browser_open`, `browser_close`, `navigate`, `snapshot`, `act`, `wait_for`, `read`, `screenshot`, `tabs`, `dialog`, `evaluate`, and `doctor`.
- Snapshots list the page elements with refs such as `e12`. Refs from an old snapshot stop working and never point at a new element.
- Each action finds a stable selector for the element, for later test plans and scripts.
- Safety guards: an allowed-sites list that also blocks clicks to other sites, `{{secret:NAME}}` values that the agent never sees, upload limits, and page text marked as untrusted.
- The `evaluate` tool is off unless `config.local.yaml` turns it on.
- The `uiwalk setup` command downloads Chrome for Testing. The `uiwalk doctor` command checks the setup.
- The server closes Chrome and removes its temporary profile when it stops.

### Changed

- The bundle now includes every package it needs. Before, an installed plugin could not start, because Puppeteer loads `chromium-bidi` and the bundle did not include it. A test now runs the plugin from a folder outside the repo.
- The planted coupon field problem in the demo shop is now a real missing label. A placeholder counts as a label for the accessibility checker.
- Tests start each demo shop and Chrome on a free port. Before, two test files could share a demo shop, and one could stop it in the middle of the other.
- The demo shop no longer logs a 401 error for a visitor who is not logged in.
- The message about missing Chrome shows the exact setup command for the installed plugin.

### Removed

- The `ping` tool from the project setup.

- Project setup: npm workspaces, TypeScript, Biome, and Vitest.
- The uiwalk MCP server, bundled into the plugin as one file.
- The walkthrough plugin skeleton and the marketplace file.
- A demo shop with planted bugs for testing.
- A text check that stops em dashes and British spellings.
- An npm version rule that blocks npm 11.5.0 to 11.6.1. These versions remove a native part of the test tools on a second install.
