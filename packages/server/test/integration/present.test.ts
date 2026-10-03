import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { repoRoot, startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// A presentation of the demo shop, moved by the control action like a presenter would.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let site: string;

const TOUR = `name: Mug tour
presentation:
  end: { title: Thank you }
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: The mug and the cart }
    notes: Say hello.
  - id: add-mug
    do: Add the mug
    action: { click: { selector: '[data-add="mug"]' } }
    expect: The header says "Cart (1)".
    notes: The count updates at once.
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    expect: The cart lists the "Coffee Mug".
`;

const KIOSK = TOUR.replace(
  'presentation:\n  end: { title: Thank you }',
  'presentation:\n  kiosk: { holdSeconds: 1 }',
).replace('name: Mug tour', 'name: Mug kiosk');

async function state(): Promise<string> {
  return (await mcp.call('present', { action: 'status' })).text;
}

async function until(text: RegExp, ms = 20_000): Promise<string> {
  const end = Date.now() + ms;
  let last = '';
  while (Date.now() < end) {
    last = await state();
    if (text.test(last)) return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`The status never matched ${text}. Last: ${last}`);
}

async function rehearse(plan: string): Promise<void> {
  const start = await mcp.call('run_start', { plan, mode: 'autonomous' });
  expect(start.isError, start.text).toBe(false);
  expect((await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' })).isError).toBe(
    false,
  );
  await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
  await mcp.call('navigate', { url: '/cart' });
  await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
  expect((await mcp.call('run_finish', {})).text).toContain('good rehearsal');
}

beforeAll(async () => {
  site = tempDir('present-site');
  cpSync(join(repoRoot, 'examples/demo-app/site'), site, { recursive: true });
  demo = await startDemoServer(site);
  const project = tempDir('present');
  mkdirSync(join(project, '.walkthrough', 'plans'), { recursive: true });
  writeFileSync(
    join(project, '.walkthrough', 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins: [${demo.base}]\naskTimeoutSec: 10\nactionTimeoutMs: 2000\n`,
  );
  writeFileSync(join(project, '.walkthrough', 'plans', 'tour.yaml'), TOUR);
  writeFileSync(join(project, '.walkthrough', 'plans', 'kiosk.yaml'), KIOSK);
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('present-tmp') });
}, 60_000);

afterAll(async () => {
  await mcp?.call('present', { action: 'stop' }).catch(() => undefined);
  await mcp?.close();
  demo?.stop();
});

describe('present', () => {
  it('needs a rehearsal first', async () => {
    const reply = await mcp.call('present', { action: 'start', plan: 'tour' });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('There is no good rehearsal of "Mug tour"');
  });

  it('plays the steps with gates, back, and jump', async () => {
    await rehearse('tour');
    const start = await mcp.call('present', { action: 'start', plan: 'tour' });
    expect(start.isError, start.text).toBe(false);
    expect(start.text).toContain('It has 3 step(s). It waits for the presenter before each step.');
    expect(await state()).toContain('State: title');

    // Only tools that read work now.
    const act = await mcp.call('act', { action: 'click', selector: 'body' });
    expect(act.isError).toBe(true);
    expect(act.text).toContain('A presentation is going');
    expect((await mcp.call('snapshot')).isError).toBe(false);

    const bad = await mcp.call('present', { action: 'control', command: 'continue' });
    expect(bad.text).toMatch(/at "title", so "continue" does not work now/);

    await mcp.call('present', { action: 'control', command: 'start' });
    let now = await until(/State: gate, at step 1 of 3/);
    expect(now).toContain('Notes: Say hello.');
    expect(now).toContain('Next: step 2 "Add the mug"');
    await mcp.call('present', { action: 'control', command: 'continue' });
    await until(/State: gate, at step 2 of 3/);
    await mcp.call('present', { action: 'control', command: 'continue' });
    await until(/State: gate, at step 3 of 3/);
    const page = (await mcp.call('read', { selector: 'header' })).text;
    expect(page).toContain('Cart (1)');

    // Back starts over and plays step 1 again at full speed.
    await mcp.call('present', { action: 'control', command: 'back' });
    await until(/State: gate, at step 2 of 3/);
    await mcp.call('present', { action: 'control', command: 'jump', step: 3 });
    now = await until(/State: gate, at step 3 of 3/);
    expect((await mcp.call('read', { selector: 'header' })).text).toContain('Cart (1)');
    await mcp.call('present', { action: 'control', command: 'continue' });
    await until(/State: end/);
  }, 120_000);

  it('tells the listener about a failed step, and takes a note', async () => {
    // The app changes after the rehearsal: the shop shows no products.
    const file = join(site, 'app.js');
    const before = readFileSync(file, 'utf8');
    writeFileSync(file, before.replace("fetch('/api/products')", "fetch('/api/nothing')"));
    try {
      await mcp.call('present', { action: 'control', command: 'jump', step: 2 });
      await until(/State: gate, at step 2 of 3/);
      await mcp.call('present', { action: 'control', command: 'continue' });
      const heard = await mcp.call('present', { action: 'listen' });
      expect(heard.text).toContain('status: step_failed');
      expect(heard.text).toContain('Step 2 did not work');
      expect(await state()).toMatch(/State: failed, at step 2 of 3/);
      const note = await mcp.call('present', {
        action: 'answer',
        text: 'The button name changed after the rehearsal.',
      });
      expect(note.text).toContain('The presenter sees the note');
      await mcp.call('present', { action: 'control', command: 'skip' });
      await until(/State: gate, at step 3 of 3/);
    } finally {
      writeFileSync(file, before);
    }
  }, 120_000);

  it('ends, and the other tools work again', async () => {
    const stop = await mcp.call('present', { action: 'stop' });
    expect(stop.text).toContain('The presentation "Mug tour" ended.');
    expect((await mcp.call('present', { action: 'listen' })).text).toContain('status: ended');
    expect((await mcp.call('browser_open')).isError).toBe(false);
  }, 60_000);

  it('runs a kiosk presentation by itself to the end', async () => {
    await rehearse('kiosk');
    const start = await mcp.call('present', { action: 'start', plan: 'kiosk' });
    expect(start.text).toContain('It runs by itself (kiosk).');
    const heard = await mcp.call('present', { action: 'listen' }, { timeoutMs: 60_000 });
    expect(heard.text).toContain('status: ended');
  }, 120_000);
});
