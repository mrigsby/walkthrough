import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startClient } from '../helpers/mcp.js';

// Starts the bundled server the same way Claude Code does.
describe('bundled server over stdio', () => {
  let mcp: Awaited<ReturnType<typeof startClient>>;

  beforeAll(async () => {
    mcp = await startClient({});
  });

  afterAll(async () => {
    await mcp.close();
  });

  it('reports its name and version', () => {
    expect(mcp.client.getServerVersion()?.name).toBe('uiwalk');
  });

  it('does not have the Phase 0 ping tool', async () => {
    const { tools } = await mcp.client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('ping');
  });

  it('answers doctor', async () => {
    const reply = await mcp.call('doctor');
    expect(reply.text).toMatch(/Walkthrough \(uiwalk\)/);
  });
});
