# Walkthrough

Walkthrough lets an AI agent test your web app in a visible browser, one step at a time. After each step, the agent tells you what it did and what you should see. You confirm the step or report a bug. When you report a bug, Walkthrough saves screenshots, console errors, and failed requests.

> Status: early development. The browser tools, the confirm panel, test plans, reports, and slash commands work. See the [plan format](docs/plan-format.md). See the [changelog](CHANGELOG.md).

## Parts

- **uiwalk**: an MCP server that controls Chrome with Puppeteer.
- **walkthrough**: a Claude Code plugin with a skill and commands that use the server.

## Requirements

- Node.js 22.12 or later
- npm 10, npm 11.4 or earlier, or npm 11.6.2 or later (see [Contributing](CONTRIBUTING.md#npm-version))
- Google Chrome

## Install in Claude Code

Walkthrough is not published yet. To try it from a copy of this repo:

1. In Claude Code, add the repo as a plugin marketplace:
   ```
   /plugin marketplace add /path/to/this/repo
   ```
2. Install the plugin:
   ```
   /plugin install walkthrough@walkthrough
   ```
3. In your project, run `/walkthrough:init http://localhost:3000`, with the address of your app.
4. Run `/walkthrough:run smoke` to try the sample plan.

## Commands

| Command | What it does |
|---|---|
| `/walkthrough:init [url]` | Makes the `.walkthrough` folder with settings and a sample plan. |
| `/walkthrough:run [plan] [mode]` | Runs a test plan in the browser. |
| `/walkthrough:plan <what to test>` | Writes a new test plan. |
| `/walkthrough:report [run]` | Shows the result of a run and writes its reports again. |
| `/walkthrough:doctor` | Checks the setup and explains how to fix problems. |

## Work on Walkthrough

```sh
npm install
npm run build
npm test
```

Start the demo shop:

```sh
npm run demo
```

In another terminal, start Claude Code in the demo project with the local plugin:

```sh
cd examples/demo-app
claude --plugin-dir ../../plugins/walkthrough
```

Run `/mcp` and check that `uiwalk` is connected. Then try `/walkthrough:run checkout`.

## Project layout

| Folder | What it holds |
|---|---|
| `packages/server` | Source of the uiwalk MCP server |
| `plugins/walkthrough` | The Claude Code plugin, with the bundled server |
| `examples/demo-app` | A demo shop with planted bugs, set up as a test project |
| `scripts` | Build, text check, and demo server scripts |
| `docs` | Guides |

## License

MIT. See [LICENSE](LICENSE).
