import { execFile } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findFfmpeg } from '../../src/downloads/ffmpeg.js';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// Clean re-recordings: run the demo plan, replay it, and export it with VIDEO=.
const run = promisify(execFile);
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;
let runId: string;

const runDir = (id: string) => join(project, '.walkthrough', 'runs', id);

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('replay');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins:\n  - ${demo.base}\nhighlightMs: 0\ndialogs: ask\n`,
  );
  // The demo plan, without its whole-run video, so the test is faster.
  const plan = readFileSync(
    join(repoRoot, 'examples/demo-app/.walkthrough/plans/checkout-demo.yaml'),
    'utf8',
  ).replace('video: true\n', '');
  writeFileSync(join(project, '.walkthrough', 'plans', 'checkout-demo.yaml'), plan);
  // The exported script imports puppeteer-core from the project.
  symlinkSync(join(repoRoot, 'node_modules'), join(project, 'node_modules'));
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('replay-tmp') });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

const pass = (stepId: string) => mcp.call('run_step', { stepId, status: 'pass' });

describe('replay', () => {
  it('runs the checkout demo plan like an agent', async () => {
    const start = await mcp.call('run_start', { plan: 'checkout-demo' });
    expect(start.isError, start.text).toBe(false);
    runId = /Run folder: \S+runs[/\\](\S+)/.exec(start.text)?.[1] as string;
    await mcp.call('navigate', { url: '/' });
    await pass('open-shop');
    await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
    await pass('add-mug');
    await mcp.call('navigate', { url: '/cart' });
    await pass('open-cart');
    let outline = (await mcp.call('snapshot')).text;
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Checkout') });
    await pass('go-to-checkout');
    outline = (await mcp.call('snapshot')).text;
    const fill = async (name: string, value: string, stepId: string) => {
      await mcp.call('act', { action: 'fill', ref: refFor(outline, 'textbox', name), value });
      await pass(stepId);
    };
    await fill('Full name', 'Demo Shopper', 'enter-name');
    await fill('Email', 'demo+{{unique}}@example.com', 'enter-email');
    await fill('Address', '1 Main Street, Springfield', 'enter-address');
    await fill('Card number', '4242 4242 4242 4242', 'enter-card');
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Save card') });
    await mcp.call('wait_for', { text: 'Card ending in 4242 is ready' });
    await pass('save-card');
    const order = await mcp.call('act', {
      action: 'click',
      ref: refFor(outline, 'button', 'Place order'),
    });
    expect(order.text).toContain('dialog');
    await mcp.call('dialog', { action: 'accept' });
    await mcp.call('wait_for', { text: 'Thank you' });
    await pass('place-order');
    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('10 passed');
  }, 120_000);

  it('records the run again as MP4 and GIF, with a new {{unique}} value', async () => {
    const reply = await mcp.call(
      'video',
      { action: 'replay', runId, format: ['mp4', 'gif'], pace: 'fast' },
      { timeoutMs: 180_000 },
    );
    expect(reply.isError, reply.text).toBe(false);
    expect(reply.text).toMatch(/Saved the replay \(MP4, [\d.]+ seconds/);
    expect(reply.text).toMatch(/Saved the replay \(GIF, [\d.]+ seconds/);
    expect(reply.images).toBe(1);
    const saved = JSON.parse(readFileSync(join(runDir(runId), 'run.json'), 'utf8'));
    const unique = /new \{\{unique\}\} value \((\w+)\)/.exec(reply.text)?.[1];
    expect(unique).toBeTruthy();
    expect(unique).not.toBe(saved.unique);
    const files = readdirSync(join(runDir(runId), 'video'));
    expect(files.some((f) => /^\d+-replay\.mp4$/.test(f))).toBe(true);
    expect(files.some((f) => /^\d+-replay\.gif$/.test(f))).toBe(true);
    expect(saved.videos.filter((v: { name: string }) => v.name === 'replay')).toHaveLength(2);
    // The replay closes its tabs and login.
    expect((await mcp.call('tabs')).text).not.toMatch(/replay-/);
    expect(readFileSync(join(runDir(runId), 'report.html'), 'utf8')).toMatch(
      /src="video\/\d+-replay\.mp4"/,
    );
  }, 200_000);

  it('stops at a step that does not work, with its name and a screenshot', async () => {
    const broken = `${runId}-broken`;
    cpSync(runDir(runId), runDir(broken), { recursive: true });
    const file = join(runDir(broken), 'run.json');
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    saved.id = broken;
    saved.steps[1].actions[0].selector = '#no-such-button';
    writeFileSync(file, JSON.stringify(saved));
    const reply = await mcp.call(
      'video',
      { action: 'replay', runId: broken, pace: 'fast' },
      { timeoutMs: 120_000 },
    );
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain(
      'The replay stopped at step 2 "Click "Add to cart" on the Coffee Mug"',
    );
    expect(reply.text).toContain('Walkthrough saved no video.');
    expect(reply.images).toBe(1);

    // An action without a stable selector cannot be replayed at all.
    delete saved.steps[1].actions[0].selector;
    writeFileSync(file, JSON.stringify(saved));
    const blocked = await mcp.call('video', { action: 'replay', runId: broken });
    expect(blocked.isError).toBe(true);
    expect(blocked.text).toMatch(/have no stable selector:\n- Step 2:/);
  }, 150_000);

  it.skipIf(!findFfmpeg())(
    'exports a script that records a video with VIDEO=',
    async () => {
      const exported = await mcp.call('export_script', { runId, installedChrome: true });
      expect(exported.isError, exported.text).toBe(false);
      const script = join(project, '.walkthrough', 'exports', 'checkout-demo.mjs');
      const { stdout } = await run(process.execPath, [script], {
        cwd: project,
        env: { ...process.env, BASE_URL: demo.base, VIDEO: 'videos/checkout.webm', PACE_MS: '5' },
        timeout: 120_000,
      }).catch((error: { message: string; stdout?: string; stderr?: string }) => {
        // Show where the script stopped. It hung once on a slow CI computer.
        throw new Error(`${error.message}\nstdout:\n${error.stdout}\nstderr:\n${error.stderr}`);
      });
      expect(stdout).toContain('Passed: every step and check.');
      expect(stdout).toContain('Saved the video: videos/checkout.webm');
      expect(existsSync(join(project, 'videos', 'checkout.webm'))).toBe(true);
    },
    150_000,
  );
});
