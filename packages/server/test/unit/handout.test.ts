import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  handoutData,
  handoutFolder,
  notesHtml,
  writeHandout,
} from '../../src/presentation/handout.js';
import { PresentationSession, type PresentStep } from '../../src/presentation/session.js';
import { tempDir } from '../helpers/temp.js';

const step = (index: number, extra: Partial<PresentStep> = {}): PresentStep => ({
  index,
  id: `s${index}`,
  title: `Step ${index}`,
  hasAction: true,
  pause: true,
  spotlight: true,
  ...extra,
});

function session() {
  const s = new PresentationSession(
    [
      step(1, { notes: 'Say **hello**.\n- one\n- two', slide: { title: 'Today' } }),
      step(2, { notes: '<script>alert(1)</script>', timeBudgetSec: 30 }),
      step(3),
    ],
    {
      name: 'Tour <b>',
      runId: 'r1',
      environment: {
        name: 'staging',
        label: 'Staging',
        color: '#b45309',
        baseUrl: 'https://staging.example.com',
      },
      kiosk: false,
      timeBudgetSec: 300,
    },
  );
  s.startedAt = Date.now() - 65_000;
  s.stepTimes.set(0, 20_000);
  s.stepTimes.set(1, 45_000);
  const q = s.ask('What is the password? It is hunter22.');
  s.answer(q.id, 'Do not say hunter22 on stage.');
  s.answer(undefined, 'Step 2 was slow.');
  return s;
}

const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);

describe('the presentation handout', () => {
  it('turns a small part of Markdown into safe HTML', () => {
    expect(notesHtml('Say **hi** and `npm test`.\n- a\n- b\n\n[Docs](https://x.dev) <i>')).toBe(
      '<p>Say <strong>hi</strong> and <code>npm test</code>.</p>\n<ul><li>a</li><li>b</li></ul>\n<p>Docs (https://x.dev) &#60;i&#62;</p>',
    );
  });

  it('writes HTML and Markdown with the environment, the steps, and the redacted chat', () => {
    const data = handoutData(session(), new Map([[0, JPEG]]), (text) =>
      text.replaceAll('hunter22', '****'),
    );
    const dir = tempDir('handout');
    const files = writeHandout(dir, data);
    const html = readFileSync(files.html, 'utf8');
    const md = readFileSync(files.md, 'utf8');
    expect(existsSync(join(dir, 'frames', 'step-01.jpg'))).toBe(true);
    expect(existsSync(join(dir, 'frames', 'step-02.jpg'))).toBe(false);

    expect(html).toContain('<h1>Tour &#60;b&#62;</h1>');
    expect(html).toContain('Staging</span> https://staging.example.com');
    expect(html).toContain('2 of 3 steps shown');
    expect(html).toContain('<img src="frames/step-01.jpg" alt="Step 1">');
    expect(html).toContain('<strong>hello</strong>');
    expect(html).toContain('&#60;script&#62;alert(1)&#60;/script&#62;');
    expect(html).not.toContain('<script>');
    expect(html).toContain('class="time over">Time: 0:45 (budget 0:30)');
    expect(html).toContain('Not shown.');
    expect(html).toContain('Q: What is the password? It is ****.');
    expect(html).toContain('<dt>Note</dt><dd>Step 2 was slow.</dd>');
    expect(html).not.toContain('hunter22');

    expect(md).toContain('- Environment: Staging (staging), https://staging.example.com');
    expect(md).toContain('![Step 1](frames/step-01.jpg)');
    expect(md).toContain('**A:** Do not say **** on stage.');
    expect(md).not.toContain('hunter22');
  });

  it('names the folder by the start time and the environment', () => {
    expect(handoutFolder(new Date(2026, 9, 2, 14, 5, 9).getTime(), 'staging')).toBe(
      '2026-10-02_140509-staging',
    );
  });
});
