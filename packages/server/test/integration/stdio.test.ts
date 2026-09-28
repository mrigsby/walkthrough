import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bundle, startClient } from '../helpers/mcp.js';

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

describe('command line', () => {
  it('lists the setup choices in the help', () => {
    const help = spawnSync(process.execPath, [bundle, 'help'], { encoding: 'utf8' });
    expect(help.stdout).toContain('setup lighthouse');
    expect(help.stdout).toContain('setup ffmpeg');
  });

  it('refuses an unknown setup choice', () => {
    const result = spawnSync(process.execPath, [bundle, 'setup', 'sparkles'], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stderr).toMatch(/Unknown setup "sparkles"/);
  });
});
