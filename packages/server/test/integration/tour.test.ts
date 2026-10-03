import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { refFor, startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// The checkout-tour plan of the demo: a rehearsal, then the whole presentation.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;

beforeAll(async () => {
  demo = await startDemoServer();
  const project = tempDir('tour');
  const folder = join(project, '.walkthrough');
  mkdirSync(join(folder, 'plans'), { recursive: true });
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins: [${demo.base}]\nhighlightMs: 0\ndialogs: ask\n`,
  );
  const demoFolder = join(repoRoot, 'examples/demo-app/.walkthrough');
  cpSync(join(demoFolder, 'slides'), join(folder, 'slides'), { recursive: true });
  // The fast pace keeps the test short. The steps stay the same.
  const plan = readFileSync(join(demoFolder, 'plans', 'checkout-tour.yaml'), 'utf8');
  writeFileSync(
    join(folder, 'plans', 'checkout-tour.yaml'),
    plan.replace('  timeBudget: 5m\n', '  timeBudget: 5m\n  pace: fast\n'),
  );
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('tour-tmp') });
}, 60_000);

afterAll(async () => {
  await mcp?.call('present', { action: 'stop' }).catch(() => undefined);
  await mcp?.close();
  demo?.stop();
});

const pass = (stepId: string) => mcp.call('run_step', { stepId, status: 'pass' });

describe('the checkout tour of the demo', () => {
  it('rehearses like an agent', async () => {
    const start = await mcp.call('run_start', { plan: 'checkout-tour' });
    expect(start.isError, start.text).toBe(false);
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
    await mcp.call('act', { action: 'click', ref: refFor(outline, 'button', 'Place order') });
    await mcp.call('dialog', { action: 'accept' });
    await mcp.call('wait_for', { text: 'Thank you' });
    await pass('place-order');
    const finish = await mcp.call('run_finish');
    expect(finish.text).toContain('10 passed');
    expect(finish.text).toContain('This run is a good rehearsal.');
  }, 120_000);

  it('presents every step to the end screen', async () => {
    const start = await mcp.call('present', { action: 'start', plan: 'checkout-tour' });
    expect(start.isError, start.text).toBe(false);
    const end = Date.now() + 120_000;
    let status = '';
    while (Date.now() < end) {
      status = (await mcp.call('present', { action: 'status' })).text;
      expect(status).not.toMatch(/State: failed/);
      if (/State: end/.test(status)) break;
      if (/State: title/.test(status))
        await mcp.call('present', { action: 'control', command: 'start' });
      else if (/State: gate/.test(status))
        await mcp.call('present', { action: 'control', command: 'continue' });
      else await new Promise((r) => setTimeout(r, 200));
    }
    expect(status).toMatch(/State: end/);
    const stop = await mcp.call('present', { action: 'stop' });
    expect(stop.text).toContain('It showed 12 of 12 step(s)');
    expect(stop.text).toMatch(/Handout: \S+presentation\.html/);
  }, 180_000);
});
