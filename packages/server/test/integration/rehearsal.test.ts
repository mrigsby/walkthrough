import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// A run of a presentation plan is its rehearsal.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;

const TOUR = `name: Mug tour
presentation:
  title: { image: .walkthrough/slides/title.svg }
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: The mug and the cart }
  - id: add-mug
    do: Add the mug
    action: { click: { selector: '[data-add="mug"]' } }
    expect: The header says "Cart (1)".
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    expect: The cart lists the "Coffee Mug".
`;

beforeAll(async () => {
  demo = await startDemoServer();
  const project = tempDir('rehearsal');
  const folder = join(project, '.walkthrough');
  mkdirSync(join(folder, 'plans'), { recursive: true });
  mkdirSync(join(folder, 'slides'), { recursive: true });
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins: [${demo.base}]\n`,
  );
  writeFileSync(join(folder, 'plans', 'tour.yaml'), TOUR);
  writeFileSync(join(folder, 'plans', 'broken.yaml'), TOUR.replace('title.svg', 'gone.svg'));
  writeFileSync(join(folder, 'slides', 'title.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('rehearsal-tmp') });
}, 60_000);

afterAll(async () => {
  await mcp?.close();
  demo?.stop();
});

async function rehearse(skipMug: boolean): Promise<string> {
  const start = await mcp.call('run_start', { plan: 'tour', mode: 'autonomous' });
  expect(start.isError, start.text).toBe(false);
  expect(start.text).toContain('This plan is a presentation. This run is its rehearsal');
  expect(start.text).toContain('[agenda] (slide only: skipped, do nothing)');
  if (skipMug) {
    await mcp.call('run_step', { stepId: 'add-mug', status: 'skip' });
  } else {
    const click = await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
    expect(click.isError, click.text).toBe(false);
    await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
  }
  await mcp.call('navigate', { url: '/cart' });
  await mcp.call('run_step', { stepId: 'open-cart', status: 'pass' });
  return (await mcp.call('run_finish', {})).text;
}

describe('rehearsals', () => {
  it('says when a run can be presented', async () => {
    expect(await rehearse(false)).toContain('This run is a good rehearsal.');
  });

  it('says why a run cannot be presented', async () => {
    const text = await rehearse(true);
    expect(text).toContain('This run is not ready for a presentation:');
    expect(text).toContain('- Step 2 "Add the mug" is skip.');
  });

  it('checks the slide images when it validates a plan', async () => {
    const reply = await mcp.call('plan', { action: 'validate', name: 'broken' });
    expect(reply.text).toMatch(/presentation\.title: The slide image .*gone\.svg does not exist/);
  });
});
