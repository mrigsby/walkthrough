import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkPanelImage } from '../../src/guards/paths.js';
import { questionView } from '../../src/panel/controller.js';
import { blocksText, copyRefs, parseInline, parseRichText } from '../../src/panel/rich-text.js';
import { buildStepView, textColorFor, viewChecklist, viewText } from '../../src/panel/view.js';
import { validatePlanText } from '../../src/run/plans.js';
import { tempDir } from '../helpers/temp.js';

describe('rich text', () => {
  it('reads paragraphs, line breaks, and inline marks', () => {
    expect(parseRichText('Open the **cart**.\nThen run `npm test`.\n\nA *second* part.')).toEqual([
      {
        t: 'p',
        lines: [
          [
            { t: 'text', v: 'Open the ' },
            { t: 'b', v: 'cart' },
            { t: 'text', v: '.' },
          ],
          [
            { t: 'text', v: 'Then run ' },
            { t: 'code', v: 'npm test' },
            { t: 'text', v: '.' },
          ],
        ],
      },
      {
        t: 'p',
        lines: [
          [
            { t: 'text', v: 'A ' },
            { t: 'i', v: 'second' },
            { t: 'text', v: ' part.' },
          ],
        ],
      },
    ]);
  });

  it('reads bullet, number, and check lists', () => {
    const blocks = parseRichText(
      'Check:\n- one\n* two\n3. three\n4. four\n- [ ] open\n- [x] done\n- [X] also done',
    );
    expect(blocks.map((b) => b.t)).toEqual(['p', 'ul', 'ol', 'check']);
    expect(blocks[1]).toEqual({
      t: 'ul',
      items: [[{ t: 'text', v: 'one' }], [{ t: 'text', v: 'two' }]],
    });
    expect(blocks[2]).toMatchObject({ t: 'ol', start: 3 });
    expect(blocks[3]).toEqual({
      t: 'check',
      items: [
        { text: [{ t: 'text', v: 'open' }], checked: false },
        { text: [{ t: 'text', v: 'done' }], checked: true },
        { text: [{ t: 'text', v: 'also done' }], checked: true },
      ],
    });
  });

  it('keeps code blocks as they are', () => {
    const blocks = parseRichText(
      'Run this:\n```bash\nnpm run seed -- --user **x**\n  cd app\n```\nDone.',
    );
    expect(blocks).toEqual([
      { t: 'p', lines: [[{ t: 'text', v: 'Run this:' }]] },
      { t: 'code', v: 'npm run seed -- --user **x**\n  cd app' },
      { t: 'p', lines: [[{ t: 'text', v: 'Done.' }]] },
    ]);
    // A code block without an end runs to the end of the text.
    expect(parseRichText('```\nopen')).toEqual([{ t: 'code', v: 'open' }]);
  });

  it('does not see marks in plain text', () => {
    expect(parseInline('2 * 3 * 4 and my_var_name')).toEqual([
      { t: 'text', v: '2 * 3 * 4 and my_var_name' },
    ]);
    // Raw HTML is only text.
    expect(parseInline('<b>hi</b>')).toEqual([{ t: 'text', v: '<b>hi</b>' }]);
  });

  it('writes blocks back as plain text', () => {
    const text = 'Run:\n\n- a\n- [x] b\n\n1. c\n\n```\nx\n```';
    expect(blocksText(parseRichText(text))).toBe('Run:\n\n- a\n\n- [x] b\n\n1. c\n\n```\nx\n```');
  });
});

describe('panel view', () => {
  it('has the old labels and buttons by default', () => {
    const view = buildStepView({ title: 'Open', didWhat: 'I opened it.', expected: 'A page.' });
    expect(view.sections.map((s) => [s.key, s.label])).toEqual([
      ['did', 'What I did'],
      ['expect', 'What you should see'],
    ]);
    expect(view.buttons.map((b) => `${b.result}:${b.label}`)).toEqual([
      'pass:Pass',
      'bug:Bug',
      'skip:Skip',
      'stop:Stop',
    ]);
    expect(view.buttons.some((b) => b.color)).toBe(false);
  });

  it('hides empty parts and adds a closed "What\'s next"', () => {
    const view = buildStepView({ title: 'Seed', expected: 'Done.', next: 'The admin page.' });
    expect(view.sections.map((s) => s.key)).toEqual(['expect', 'next']);
    expect(view.sections[1]).toMatchObject({
      label: "What's next",
      collapsible: true,
      collapsed: true,
    });
  });

  it('lets later layers win, part by part', () => {
    const view = buildStepView({
      title: 'Seed',
      didWhat: 'Nothing yet.',
      expected: 'Done.',
      next: 'Admin.',
      layers: [
        {
          labels: { did: 'Setup', next: 'Then' },
          buttons: { pass: { label: 'Looks good', color: '#15803d' }, skip: { show: false } },
        },
        {
          labels: { expect: '' },
          next: { collapsed: false },
          buttons: { pass: { label: 'Done' } },
        },
        undefined,
      ],
    });
    expect(view.sections.map((s) => s.label)).toEqual(['Setup', '', 'Then']);
    expect(view.sections[2]?.collapsed).toBe(false);
    expect(view.buttons.map((b) => b.label)).toEqual(['Done', 'Bug', 'Stop']);
    expect(view.buttons[0]).toMatchObject({ color: '#15803d', textColor: '#ffffff' });
  });

  it('picks a readable text color', () => {
    expect(textColorFor('#000')).toBe('#ffffff');
    expect(textColorFor('#b91c1c')).toBe('#ffffff');
    expect(textColorFor('#fde047')).toBe('#0f172a');
    expect(textColorFor('#ffffff')).toBe('#0f172a');
  });

  it('keeps the confirm question as it was', () => {
    const view = questionView({
      kind: 'confirm',
      title: 'Use Production?',
      didWhat: 'Use the "production" environment?',
      expected: '',
      confirmLabel: 'Use Production',
      color: '#b91c1c',
    });
    expect(view).toMatchObject({ kind: 'confirm', notes: false, color: '#b91c1c' });
    expect(view.buttons.map((b) => `${b.result}:${b.label}`)).toEqual([
      'pass:Use Production',
      'stop:Cancel',
    ]);
  });

  it('writes the question for chat', () => {
    const view = buildStepView({
      title: 'Seed',
      didWhat: 'I ran it.',
      expected: '- [ ] It printed Done',
      layers: [{ buttons: { bug: { show: false } } }],
    });
    expect(viewText(view)).toBe(
      'Step: Seed\nWhat I did:\nI ran it.\nWhat you should see:\n- [ ] It printed Done\nAnswers: Pass, Skip, Stop',
    );
  });
});

describe('panel keys in plans', () => {
  it('accepts panel settings on the plan and on a step', () => {
    const result = validatePlanText(`name: Panels
panel:
  labels: { did: Setup, expect: Check, next: Then }
  next: { collapsed: false, auto: true }
  buttons:
    pass: { label: Looks good, color: "#15803d" }
    bug: { show: false }
  corner: top-left
steps:
  - do: Run the seed script
    next: The agent opens the admin page.
    panel:
      labels: { did: "" }
      next: { collapsed: true }
      buttons: { stop: { label: Cancel } }
`);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });

  it('rejects unknown panel settings with clear messages', () => {
    const bad = (text: string) => {
      const result = validatePlanText(text);
      return result.ok ? [] : result.problems.map((p) => p.message);
    };
    expect(
      bad('name: P\npanel: { buttons: { pass: { show: false } } }\nsteps:\n  - do: One\n'),
    ).not.toEqual([]);
    expect(
      bad('name: P\npanel: { buttons: { pass: { color: green } } }\nsteps:\n  - do: One\n')[0],
    ).toMatch(/hex color/);
    expect(bad('name: P\nsteps:\n  - do: One\n    panel: { corner: top-left }\n')).not.toEqual([]);
  });
});

describe('snippets', () => {
  it('reads {{copy:name}} as a snippet chip', () => {
    expect(parseInline('Run {{copy:seed}} and {{ copy:db_reset }}.')).toEqual([
      { t: 'text', v: 'Run ' },
      { t: 'copy', id: 'seed' },
      { t: 'text', v: ' and ' },
      { t: 'copy', id: 'db_reset' },
      { t: 'text', v: '.' },
    ]);
    expect(copyRefs('{{copy:a}} {{copy:b}} {{copy:a}}')).toEqual(['a', 'b']);
    expect(blocksText(parseRichText('Run {{copy:a}}.'), { a: { code: 'npm test' } })).toBe(
      'Run `npm test`.',
    );
  });

  it('puts only the snippets that the text uses in the view', () => {
    const view = buildStepView({
      title: 'Seed',
      expected: 'Run {{copy:seed}}.',
      snippets: {
        seed: { code: 'npm run seed', help: 'Then run {{copy:check}}.' },
        check: { code: 'npm run check' },
        unused: { code: 'rm -rf x' },
      },
    });
    expect(Object.keys(view.snippets).sort()).toEqual(['check', 'seed']);
    expect(view.snippets.seed?.help?.[0]?.t).toBe('p');
    expect(viewText(view)).toContain('Run `npm run seed`.');
  });

  it('checks snippets in plans', () => {
    const problems = (text: string) => {
      const result = validatePlanText(text);
      return result.ok ? [] : result.problems.map((p) => `${p.line}: ${p.message}`);
    };
    expect(
      problems(`name: S
snippets:
  seed: npm run seed
steps:
  - do: One
    expect: Run {{copy:seed}} and {{copy:own}}.
    next: Then {{copy:seed}}.
    snippets:
      own: { code: echo hi, help: "Says hi. See {{copy:seed}}." }
`),
    ).toEqual([]);
    expect(problems('name: S\nsteps:\n  - do: One\n    expect: Run {{copy:nope}}.\n')[0]).toBe(
      '4: There is no snippet "nope". Add it to "snippets" in the plan or in this step.',
    );
    expect(
      problems('name: S\nsnippets:\n  login: "pw {{secret:PASSWORD}}"\nsteps:\n  - do: One\n')[0],
    ).toMatch(/never copies secrets/);
    expect(problems('name: S\nsnippets:\n  bad name: x\nsteps:\n  - do: One\n')[0]).toMatch(
      /snippet name/,
    );
  });
});

describe('check lists and images in the view', () => {
  it('gives each check list item an id, and uses the ticks', () => {
    const view = buildStepView({
      title: 'T',
      didWhat: '- [x] did it',
      expected: 'Look:\n- [ ] one\n- [ ] `two`',
    });
    expect(viewChecklist(view)).toEqual([
      { id: 'did:0:0', text: 'did it', checked: true },
      { id: 'expect:1:0', text: 'one', checked: false },
      { id: 'expect:1:1', text: '`two`', checked: false },
    ]);
    expect(
      viewChecklist(view, { 'check:did:0:0': false, 'check:expect:1:1': true }).map(
        (i) => i.checked,
      ),
    ).toEqual([false, false, true]);
  });

  it('marks a reference image and checks its file', () => {
    expect(buildStepView({ title: 'T', expected: 'x', image: true }).image).toBe(true);
    const dir = tempDir('panel-image');
    mkdirSync(join(dir, 'docs'), { recursive: true });
    writeFileSync(join(dir, 'docs', 'a.png'), 'x');
    writeFileSync(join(dir, 'docs', 'b.svg'), 'x');
    writeFileSync(join(dir, 'docs', 'big.png'), Buffer.alloc(2 * 1024 * 1024));
    expect(checkPanelImage('docs/a.png', dir)).toContain('a.png');
    expect(() => checkPanelImage('docs/b.svg', dir)).toThrow(/reference image ends with/);
    expect(() => checkPanelImage('docs/big.png', dir)).toThrow(/larger than 1.5 MB/);
    expect(() => checkPanelImage('docs/none.png', dir)).toThrow(/does not exist/);
  });

  it('accepts expectImage in plans, and only images', () => {
    expect(
      validatePlanText('name: I\nsteps:\n  - do: One\n    expectImage: docs/a.webp\n').ok,
    ).toBe(true);
    expect(validatePlanText('name: I\nsteps:\n  - do: One\n    expectImage: docs/a.gif\n').ok).toBe(
      false,
    );
  });
});
