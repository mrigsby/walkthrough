# Use with other tools and share with a team

## Share tests with your team

Commit these files, so your team can run the same tests:

| File or folder | Why |
| --- | --- |
| `.walkthrough/config.yaml` | The start page and the allowed sites. |
| `.walkthrough/plans/` | The test plans. |
| `.walkthrough/plan.schema.json` | Autocomplete for plans in the editor. |
| `.walkthrough/.env.example` | The names of the secrets, without values. |
| `.walkthrough/baselines/` | Optional. Baselines for visual checks. Each file is for one operating system. |
| `.walkthrough/exports/` | Optional. Scripts for CI. |

Never commit `.walkthrough/.env`, `sessions/`, `runs/`, or `config.local.yaml`. The `.gitignore` that `/walkthrough:init` makes keeps them out.

## Install the plugin for your whole team

Add this to `.claude/settings.json` in your project, and commit it:

```json
{
  "extraKnownMarketplaces": {
    "walkthrough": {
      "source": {
        "source": "github",
        "repo": "oistechnologies/walkthrough"
      }
    }
  },
  "enabledPlugins": {
    "walkthrough@walkthrough": true
  }
}
```

When a teammate trusts the project folder, Claude Code asks them to install the marketplace and the plugin. See [Plugin marketplaces](https://code.claude.com/docs/en/plugin-marketplaces) for more.

## Use the server with other MCP clients

The `uiwalk` server works with any MCP client that can start a local (stdio) server. The skill and the slash commands work only in Claude Code. In other clients, the tool descriptions guide the agent.

Walkthrough is not on npm yet. Clone the repository. The server is one file, `plugins/walkthrough/server/uiwalk.mjs`, and it needs no `npm install`. The examples below use `/path/to/walkthrough` for the clone.

Most clients do not tell the server which project is open, so set `UIWALK_PROJECT_DIR`.

### Claude Desktop

Edit the config file:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "uiwalk": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/walkthrough/plugins/walkthrough/server/uiwalk.mjs"],
      "env": {
        "UIWALK_PROJECT_DIR": "/path/to/your/project"
      }
    }
  }
}
```

Quit Claude Desktop and open it again.

### Cursor

Add `.cursor/mcp.json` to your project:

```json
{
  "mcpServers": {
    "uiwalk": {
      "command": "node",
      "args": ["/path/to/walkthrough/plugins/walkthrough/server/uiwalk.mjs"],
      "env": {
        "UIWALK_PROJECT_DIR": "${workspaceFolder}"
      }
    }
  }
}
```

### VS Code

Add `.vscode/mcp.json` to your project. VS Code uses `servers`, not `mcpServers`:

```json
{
  "servers": {
    "uiwalk": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/walkthrough/plugins/walkthrough/server/uiwalk.mjs"],
      "env": {
        "UIWALK_PROJECT_DIR": "${workspaceFolder}"
      }
    }
  }
}
```

### Help the agent in other clients

The skill teaches the agent the test workflow. To give other agents the same help, copy the text of `plugins/walkthrough/skills/walkthrough/SKILL.md` into their instructions, such as a Cursor rule or `.github/copilot-instructions.md`.

### Timeouts in other clients

Many clients stop a tool call after about 60 seconds. So outside Claude Code, `ask_developer` waits 50 seconds for your answer, then tells the agent to wait again. The question stays in the panel. To change this, set `askTimeoutSec` in `.walkthrough/config.yaml`.

## Run tests in CI

`/walkthrough:export` turns a finished run into a plain Puppeteer script in `.walkthrough/exports/`. The script does not need an agent, so it can run in CI.

1. Add Puppeteer to your project: `npm install --save-dev puppeteer`.
2. Put the secrets that the script lists in your CI secrets.
3. Start your app. Then run the script.

An example for GitHub Actions:

```yaml
name: UI checks
on: [push, pull_request]

jobs:
  walkthrough:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Start the app
        run: |
          npm start &
          until curl -s http://localhost:3000 > /dev/null; do sleep 1; done
      - name: Run the checkout check
        run: node .walkthrough/exports/checkout.mjs
        env:
          BASE_URL: http://localhost:3000
          APP_PASSWORD: ${{ secrets.APP_PASSWORD }}
```

The script prints `ok` for each step. When a check fails, it prints the step and the reason, saves `walkthrough-export-failure.png` in the project folder, and exits with code 1.
