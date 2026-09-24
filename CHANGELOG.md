# Changelog

This file lists all notable changes to the project.

## Unreleased

### Added

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
