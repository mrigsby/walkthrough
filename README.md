# Walkthrough

Walkthrough lets an AI agent test your web app in a visible browser, one step at a time. After each step, the agent tells you what it did and what you should see. You confirm the step or report a bug. When you report a bug, Walkthrough saves screenshots, console errors, and failed requests.

> Status: early development. The browser tools work. The confirm panel, test plans, and reports come next. See the [changelog](CHANGELOG.md).

## Parts

- **uiwalk**: an MCP server that controls Chrome with Puppeteer.
- **walkthrough**: a Claude Code plugin with a skill and commands that use the server.

## Requirements

- Node.js 22.12 or later
- npm 10, npm 11.4 or earlier, or npm 11.6.2 or later (see [Contributing](CONTRIBUTING.md#npm-version))
- Google Chrome

## Try it from this repo

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

Run `/mcp` and check that `uiwalk` is connected. Then ask Claude to open the demo shop and walk through it.

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
