# Contributing

Thank you for your help. This page explains how the project works and how to change it.

## Set up

You need Node.js 22.12 or later and Google Chrome.

```sh
npm install
npm run build
npm test
```

### npm version

Use npm 10, npm 11.4 or earlier, or npm 11.6.2 or later. npm 11.5.0 to 11.6.1 has a bug: a second `npm install` removes a native part of the test tools, and `npm test` then fails with "Cannot find native binding".

The project blocks these npm versions. If `npm install` stops with `EBADENGINE`, update npm:

```sh
npm install -g npm@11
```

Then remove `node_modules` and `package-lock.json`, and run `npm install` again.

## Project layout

| Folder | What it holds |
| --- | --- |
| `packages/server/src` | The source of the `uiwalk` MCP server, in TypeScript. |
| `packages/server/test` | Unit tests and integration tests. |
| `plugins/walkthrough` | The Claude Code plugin: skill, commands, and the bundled server. |
| `.claude-plugin/marketplace.json` | The marketplace that lists the plugin. |
| `examples/demo-app` | A demo shop with bugs on purpose. It is also a test project with plans. |
| `schemas` | The JSON Schema for test plans. The build makes it. |
| `scripts` | The build, the text check, the schema build, and the demo server. |
| `docs` | The guides. |

Inside `packages/server/src`:

| Folder | What it does |
| --- | --- |
| `browser/` | Starts or connects to Chrome, and handles tabs, dialogs, devices, and saved logins. |
| `page/` | Page outlines, refs, actions, selectors, and element reads. |
| `panel/` | The panel in the browser and its link to the server. |
| `guards/` | Allowed sites, secrets, upload paths, and the marks on page text. |
| `evidence/` | Screenshots, logs, and the removal of tokens. |
| `run/` | Test plans, runs, and step results. |
| `report/` | The Markdown and HTML reports. |
| `visual/`, `audit/` | Visual checks and accessibility audits. |
| `record/`, `export/`, `issue/` | Record mode, script export, and issue drafts. |
| `tools/` | The MCP tools. Each file registers a group of tools. |

## Change the server

1. Edit the source in `packages/server/src`.
2. Run `npm run build:plugin`. It updates the bundle in `plugins/walkthrough/server`, the plan schema, and the copy of the plan guide in the skill. Use `npm run build:plugin -- --watch` while you work.
3. Commit the updated bundle with your change. `npm run check:bundle` fails when the bundle does not match the source.

## Test with Claude Code

```sh
npm run demo
cd examples/demo-app
claude --plugin-dir ../../plugins/walkthrough
```

After a rebuild, run `/mcp` in Claude Code and reconnect `uiwalk`.

## Tests

- `npm test` builds the bundle, runs all tests, and runs the text check.
- The integration tests start the bundled server over stdio, like Claude Code does. They use a hidden Chrome.
- `UIWALK_FORCE_PANEL=1` shows the panel in a hidden Chrome. `UIWALK_DEBUG_PORT` lets a test connect to the same Chrome and click the panel like a person.
- Tests start the demo shop with `--port 0`, so the system picks a free port. Do not use fixed or random ports in tests. Two test files that share a port share one server, and the first file to finish stops it.
- Make temp folders with `tempDir()` from `test/helpers/temp.ts`. It removes them after the test file.

### Debug a test

Set `UIWALK_TRACE_FILE` to a file path. The server then writes one JSON line for each action, with the element under each click and the page address after it.

```sh
UIWALK_TRACE_FILE=/tmp/uiwalk-trace.jsonl npx vitest run packages/server/test/integration/tools.test.ts
```

## Rules for code

- Keep code comments short and simple.
- The server writes logs to stderr with `log` from `src/log.ts`. Never write to stdout. Stdout carries the MCP messages. Biome stops `console.log` in the server source.
- Show errors to the agent with `ToolError`. Write the message in plain words, and say how to fix the problem.
- Mark text from web pages with `untrusted()` before it goes to the agent.

## Rules for text

- Write in American English (color, behavior, canceled).
- Do not use em dashes. Use a comma, a colon, or a period.
- Use short sentences and plain words. Say who does what.
- `npm run check:text` checks for em dashes and British spellings. It runs as part of `npm test`.

## CI

GitHub Actions runs `.github/workflows/ci.yml` on each push to `main` and on each pull request. It runs lint, the type check, and the tests on Linux (Node 22 and 24) and macOS (Node 24). It also fails if the committed bundle does not match the source.

## Make a release

1. Set the same version in `packages/server/package.json`, `plugins/walkthrough/.claude-plugin/plugin.json`, and `.claude-plugin/marketplace.json`.
2. Move the "Unreleased" notes in `CHANGELOG.md` under the new version.
3. Run `npm run build`, `npm test`, and `npm run check:bundle`.
4. Run `npm pack -w packages/server --dry-run` to see the files in the npm package.
5. Commit the change.
6. Tag the commit, such as `v0.1.0`.
7. Push the commit and the tag.
8. To publish the npm package, run `npm publish -w packages/server`. The `prepack` step builds the bundle first.
