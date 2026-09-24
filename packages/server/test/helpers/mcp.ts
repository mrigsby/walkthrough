import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { repoRoot } from './demo-server.js';

export const bundle = join(repoRoot, 'plugins/walkthrough/server/uiwalk.mjs');

export interface ToolReply {
  text: string;
  isError: boolean;
  images: number;
}

// Starts the bundled server over stdio, like Claude Code does.
export async function startClient(
  env: Record<string, string>,
  serverFile = bundle,
): Promise<{
  call: (name: string, args?: Record<string, unknown>) => Promise<ToolReply>;
  client: Client;
  close: () => Promise<void>;
}> {
  const client = new Client({ name: 'uiwalk-test', version: '0.0.0' });
  await client.connect(
    new StdioClientTransport({
      command: process.execPath,
      args: [serverFile],
      env: { ...(process.env as Record<string, string>), UIWALK_HEADLESS: '1', ...env },
      stderr: 'ignore',
    }),
  );
  const call = async (name: string, args: Record<string, unknown> = {}): Promise<ToolReply> => {
    const result = await client.callTool({ name, arguments: args });
    const parts = result.content as Array<{ type: string; text?: string }>;
    return {
      text: parts
        .filter((p) => p.type === 'text')
        .map((p) => p.text)
        .join('\n'),
      isError: Boolean(result.isError),
      images: parts.filter((p) => p.type === 'image').length,
    };
  };
  return { call, client, close: () => client.close() };
}

// Finds the ref for an element in a snapshot, like: - [e12] button "Log in"
export function refFor(snapshot: string, role: string, name: string | RegExp): string {
  for (const line of snapshot.split('\n')) {
    const match = /\[(e\d+)\] (\S+)(?: "([^"]*)")?/.exec(line);
    if (!match || match[2] !== role) continue;
    const found = match[3] ?? '';
    if (typeof name === 'string' ? found === name : name.test(found)) return match[1] as string;
  }
  throw new Error(`No ${role} "${name}" in snapshot:\n${snapshot}`);
}
