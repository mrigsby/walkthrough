import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDemoServer } from '../helpers/demo-server.js';
import { startClient } from '../helpers/mcp.js';
import { tempDir } from '../helpers/temp.js';

// After the talk: the recording of the audience screen, and the handout.
let demo: Awaited<ReturnType<typeof startDemoServer>>;
let mcp: Awaited<ReturnType<typeof startClient>>;
let project: string;

const TOUR = `name: Handout tour
presentation:
  record: true
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: The mug }
    notes: Welcome to the **demo**.
  - id: add-mug
    do: Add the mug
    action: { click: { selector: '[data-add="mug"]' } }
    notes: The count changes.
`;

async function until(want: RegExp): Promise<string> {
  const end = Date.now() + 20_000;
  let last = '';
  while (Date.now() < end) {
    last = (await mcp.call('present', { action: 'status' })).text;
    if (want.test(last)) return last;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`The status never matched ${want}. Last: ${last}`);
}

beforeAll(async () => {
  demo = await startDemoServer();
  project = tempDir('handout');
  const folder = join(project, '.walkthrough');
  mkdirSync(join(folder, 'plans'), { recursive: true });
  writeFileSync(
    join(folder, 'config.yaml'),
    `baseUrl: ${demo.base}\nallowedOrigins: [${demo.base}]\nvideo: { runFormat: webm, idleSeconds: 0.5 }\n`,
  );
  writeFileSync(join(folder, '.env'), 'DEMO_PASSWORD=hunter22\n');
  writeFileSync(join(folder, 'plans', 'tour.yaml'), TOUR);
  mcp = await startClient({ UIWALK_PROJECT_DIR: project, TMPDIR: tempDir('handout-tmp') });
  await mcp.call('run_start', { plan: 'tour', mode: 'autonomous' });
  await mcp.call('act', { action: 'click', selector: '[data-add="mug"]' });
  await mcp.call('run_step', { stepId: 'add-mug', status: 'pass' });
  await mcp.call('run_finish', {});
}, 90_000);

afterAll(async () => {
  await mcp?.call('present', { action: 'stop' }).catch(() => undefined);
  await mcp?.close();
  demo?.stop();
});

describe('the end of a presentation', () => {
  it('writes the handout and the recording, without secrets and with short waits', async () => {
    const start = await mcp.call('present', { action: 'start', plan: 'tour' });
    expect(start.isError, start.text).toBe(false);
    await mcp.call('present', { action: 'control', command: 'start' });
    await until(/State: gate, at step 1 of 2/);
    // A long wait at a gate becomes a short one in the video.
    await new Promise((r) => setTimeout(r, 5000));
    await mcp.call('present', { action: 'control', command: 'continue' });
    await until(/State: gate, at step 2 of 2/);
    await mcp.call('present', { action: 'answer', text: 'The password is hunter22.' });
    await mcp.call('present', { action: 'control', command: 'continue' });
    await until(/State: end/);

    const stop = await mcp.call('present', { action: 'stop' });
    expect(stop.isError, stop.text).toBe(false);
    expect(stop.text).toContain('It showed 2 of 2 step(s)');
    const handout = /Handout: (\S+) and (\S+)\./.exec(stop.text);
    const video = /Recording: (\S+) \(WEBM, (\d+):(\d\d),/.exec(stop.text);
    expect(handout, stop.text).not.toBeNull();
    expect(video, stop.text).not.toBeNull();
    const [, html, md] = handout as RegExpExecArray;
    const dir = join(project, html as string, '..');
    expect(existsSync(join(project, md as string))).toBe(true);
    expect(readdirSync(join(dir, 'frames')).sort()).toEqual(['step-01.jpg', 'step-02.jpg']);
    expect(existsSync(join(project, (video as RegExpExecArray)[1] as string))).toBe(true);

    const page = readFileSync(join(project, html as string), 'utf8');
    expect(page).toContain('2 of 2 steps shown');
    expect(page).toContain('<strong>demo</strong>');
    expect(page).toContain('The password is ****.');
    expect(page).toContain('<video controls src="presentation.webm">');
    expect(page).not.toContain('hunter22');

    // The 5 second wait shrank. Without that, the video would be longer than the talk,
    // because it also has the title before Start and a hold at the end.
    const [, , m, s] = video as RegExpExecArray;
    const talk = /in (\d+):(\d\d)\./.exec(stop.text) as RegExpExecArray;
    const videoSeconds = Number(m) * 60 + Number(s);
    const talkSeconds = Number(talk[1]) * 60 + Number(talk[2]);
    expect(videoSeconds).toBeLessThan(talkSeconds);
  }, 120_000);
});
