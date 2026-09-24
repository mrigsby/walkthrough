# Contributing

Thank you for your help.

## Set up

```sh
npm install
npm run build
npm test
```

## npm version

Use npm 10, npm 11.4 or earlier, or npm 11.6.2 or later. npm 11.5.0 to 11.6.1 has a bug: a second `npm install` removes a native part of the test tools, and `npm test` then fails with "Cannot find native binding".

The project blocks these npm versions. If `npm install` stops with `EBADENGINE`, update npm:

```sh
npm install -g npm@11
```

Then remove `node_modules` and `package-lock.json`, and run `npm install` again.

## Rules for text

- Write in American English (color, behavior, canceled).
- Do not use em dashes. Use a comma, colon, or period.
- Keep code comments short and simple.
- `npm run check:text` checks these rules. It runs as part of `npm test`.

## Change the server

1. Edit the source in `packages/server/src`.
2. Run `npm run build:plugin` to update the bundle in `plugins/walkthrough/server`. Use `npm run build:plugin -- --watch` while you work.
3. Commit the updated bundle with your change.

## Debug a test

Set `UIWALK_TRACE_FILE` to a file path. The server then writes one JSON line for each action, with the element under each click and the page address after it.

```sh
UIWALK_TRACE_FILE=/tmp/uiwalk-trace.jsonl npx vitest run packages/server/test/integration/tools.test.ts
```

Tests start the demo shop with `--port 0`, so the system picks a free port. Do not use fixed or random ports in tests. Two test files that share a port share one server, and the first file to finish stops it.

## Test with Claude Code

```sh
npm run demo
cd examples/demo-app
claude --plugin-dir ../../plugins/walkthrough
```

After a rebuild, run `/mcp` in Claude Code and reconnect `uiwalk`.
