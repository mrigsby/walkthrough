import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { repoRoot } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';

// Checks the plugin files against the real server.
const pluginDir = join(repoRoot, 'plugins/walkthrough');
const PREFIX = 'mcp__plugin_walkthrough_uiwalk__';
let toolNames: string[];
let mcp: Awaited<ReturnType<typeof startClient>>;

function frontmatter(file: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/.exec(readFileSync(file, 'utf8'));
  if (!match?.[1]) throw new Error(`${file} has no frontmatter`);
  return parse(match[1]) as Record<string, unknown>;
}

beforeAll(async () => {
  mcp = await startClient({});
  toolNames = (await mcp.client.listTools()).tools.map((t) => t.name);
});

afterAll(async () => {
  await mcp?.close();
});

describe('plugin files', () => {
  const commands = readdirSync(join(pluginDir, 'commands')).filter((f) => f.endsWith('.md'));

  it('has the commands', () => {
    expect(commands.sort()).toEqual([
      'bug.md',
      'doctor.md',
      'export.md',
      'init.md',
      'plan.md',
      'record.md',
      'report.md',
      'run.md',
    ]);
  });

  it.each(commands)('%s names only tools that exist', (file) => {
    const meta = frontmatter(join(pluginDir, 'commands', file));
    expect(typeof meta.description).toBe('string');
    const allowed = String(meta['allowed-tools'] ?? '')
      .split(',')
      .map((t) => t.trim())
      .filter(Boolean);
    for (const tool of allowed) {
      expect(tool.startsWith(PREFIX), tool).toBe(true);
      const name = tool.slice(PREFIX.length);
      if (name !== '*') expect(toolNames, `${file} names ${name}`).toContain(name);
    }
  });

  it('has the skill references it points to', () => {
    const skill = readFileSync(join(pluginDir, 'skills/walkthrough/SKILL.md'), 'utf8');
    const refs = [...skill.matchAll(/`(references\/[\w-]+\.md)`/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs)
      expect(existsSync(join(pluginDir, 'skills/walkthrough', ref)), ref).toBe(true);
  });

  it('keeps the plan guide copy up to date', () => {
    const guide = readFileSync(join(repoRoot, 'docs/plan-format.md'), 'utf8');
    const copy = readFileSync(
      join(pluginDir, 'skills/walkthrough/references/plan-format.md'),
      'utf8',
    );
    expect(copy.endsWith(guide), 'Run "npm run build:plugin".').toBe(true);
  });

  it('uses the same version everywhere', () => {
    const server = JSON.parse(
      readFileSync(join(repoRoot, 'packages/server/package.json'), 'utf8'),
    ).version;
    const plugin = JSON.parse(
      readFileSync(join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'),
    ).version;
    const market = JSON.parse(
      readFileSync(join(repoRoot, '.claude-plugin/marketplace.json'), 'utf8'),
    );
    expect(plugin).toBe(server);
    expect(market.plugins[0].version).toBe(server);
    expect(mcp.client.getServerVersion()?.version).toBe(server);
  });

  it('passes claude plugin validate, when Claude Code is installed', () => {
    let claude = '';
    try {
      claude = execFileSync('which', ['claude'], { encoding: 'utf8' }).trim();
    } catch {}
    if (!claude) return;
    for (const target of [pluginDir, repoRoot]) {
      const out = execFileSync(claude, ['plugin', 'validate', target], { encoding: 'utf8' });
      expect(out).toMatch(/Validation passed/);
    }
  });
});
