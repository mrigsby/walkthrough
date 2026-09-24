import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

// Starts the bundled server the same way Claude Code does.
const bundle = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../../../plugins/walkthrough/server/uiwalk.mjs',
);

describe('bundled server over stdio', () => {
  const client = new Client({ name: 'uiwalk-test', version: '0.0.0' });

  beforeAll(async () => {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [bundle] }));
  });

  afterAll(async () => {
    await client.close();
  });

  it('lists the ping tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toContain('ping');
  });

  it('answers ping', async () => {
    const result = await client.callTool({ name: 'ping', arguments: { message: 'hi' } });
    const content = result.content as Array<{ type: string; text: string }>;
    expect(content[0]?.text).toMatch(/^pong: hi/);
  });
});
