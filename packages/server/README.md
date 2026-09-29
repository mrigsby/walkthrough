# walkthrough-ui

This package has `uiwalk`, the MCP server of [Walkthrough](https://github.com/mrigsby/walkthrough). It lets an AI agent test your web app in a visible Chrome, one step at a time, with you. After each step, you confirm it or report a bug in a panel in the browser.

In Claude Code, install the Walkthrough plugin instead. It includes this server, a skill, and slash commands:

```text
/plugin install walkthrough --marketplace mrigsby/walkthrough
```

This command needs Claude Code 2.1.275 or later. With an earlier version, add the marketplace first, and then install the plugin:

```text
/plugin marketplace add mrigsby/walkthrough
/plugin install walkthrough@walkthrough
```

## Use with other MCP clients

Add a local (stdio) server that runs `npx -y walkthrough-ui`. Set `UIWALK_PROJECT_DIR` to your project folder. For example, in Cursor (`.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "uiwalk": {
      "command": "npx",
      "args": ["-y", "walkthrough-ui"],
      "env": { "UIWALK_PROJECT_DIR": "${workspaceFolder}" }
    }
  }
}
```

## Commands

To use these commands, install the package with `npm install -g walkthrough-ui`. Or put `npx -y walkthrough-ui` in place of `uiwalk`, such as `npx -y walkthrough-ui doctor`.

| Command | What it does |
| --- | --- |
| `uiwalk` or `uiwalk serve` | Start the MCP server. |
| `uiwalk init` | Make the `.walkthrough` folder in the current folder. |
| `uiwalk doctor` | Check Node, Chrome, the project settings, Lighthouse, and ffmpeg. |
| `uiwalk setup` | Download Chrome for Testing, if Chrome is not installed. |
| `uiwalk setup lighthouse` | Install Lighthouse, for Lighthouse reports. |
| `uiwalk setup ffmpeg` | Download ffmpeg, for MP4 videos when Chrome cannot make them. It checks the SHA-256 hash. |
| `uiwalk schema` | Print the JSON Schema for test plans. |

Walkthrough needs Node.js 22.19 or later and Google Chrome. Add `--force` to a `setup` command to download again.

See the [documentation](https://github.com/mrigsby/walkthrough#documentation) for the guides. MIT license.
