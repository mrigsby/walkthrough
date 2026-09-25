# uiwalk

`uiwalk` is the MCP server of [Walkthrough](https://github.com/mrigsby/walkthrough). It lets an AI agent test your web app in a visible Chrome, one step at a time, with you. After each step, you confirm it or report a bug in a panel in the browser.

In Claude Code, install the Walkthrough plugin instead. It includes this server, a skill, and slash commands:

```text
/plugin marketplace add mrigsby/walkthrough
/plugin install walkthrough@walkthrough
```

## Use with other MCP clients

Add a local (stdio) server that runs `npx -y uiwalk`. Set `UIWALK_PROJECT_DIR` to your project folder. For example, in Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "uiwalk": {
      "command": "npx",
      "args": ["-y", "uiwalk"],
      "env": { "UIWALK_PROJECT_DIR": "${workspaceFolder}" }
    }
  }
}
```

## Commands

| Command | What it does |
| --- | --- |
| `uiwalk` or `uiwalk serve` | Start the MCP server. |
| `uiwalk init` | Make the `.walkthrough` folder in the current folder. |
| `uiwalk doctor` | Check Node, Chrome, and the project settings. |
| `uiwalk setup` | Download Chrome for Testing, if Chrome is not installed. |
| `uiwalk schema` | Print the JSON Schema for test plans. |

Walkthrough needs Node.js 22.12 or later and Google Chrome.

See the [documentation](https://github.com/mrigsby/walkthrough#documentation) for the guides. MIT license.
