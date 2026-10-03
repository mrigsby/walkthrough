import { describe, expect, it } from 'vitest';
import { runOps } from '../../src/replay/engine.js';
import { dialogAnswers, type Op, opsByStep } from '../../src/replay/ops.js';
import { Rebaser } from '../../src/replay/rebase.js';

const action = (name: string, value?: string): Op => ({
  type: 'action',
  action: { action: name as never, label: name, value, url: '' },
});

describe('Rebaser', () => {
  const r = new Rebaser(
    ['https://staging.example.com', 'https://example.com/preview/', undefined],
    'https://www.example.com',
  );

  it('moves addresses on a known site, and the longest base wins', () => {
    expect(r.url('https://staging.example.com/cart?x=1#top')).toBe(
      'https://www.example.com/cart?x=1#top',
    );
    expect(r.url('https://example.com/preview/a/b')).toBe('https://www.example.com/a/b');
    expect(r.url('https://cdn.example.com/a.js')).toBe('https://cdn.example.com/a.js');
    expect(r.url('/relative')).toBe('/relative');
  });

  it('moves cookie domains and mock patterns', () => {
    expect(r.host('staging.example.com')).toBe('www.example.com');
    expect(r.host('.staging.example.com')).toBe('.www.example.com');
    expect(r.host('other.example.com')).toBe('other.example.com');
    expect(r.pattern('https://staging.example.com/api/*')).toBe('https://www.example.com/api/*');
    expect(r.pattern('/api/stock')).toBe('/api/stock');
  });

  it('changes nothing when the run and the replay use the same site', () => {
    const same = new Rebaser(['http://localhost:4321'], 'http://localhost:4321');
    expect(same.url('http://localhost:4321/cart')).toBe('http://localhost:4321/cart');
  });
});

describe('dialog answers of a step', () => {
  const ops: Op[] = [
    action('click'),
    action('dialog', '{"accept":true}'),
    action('click'),
    action('dialog', '{"accept":false}'),
    action('dialog', '{"accept":true,"text":"Ann"}'),
  ];

  it('lists the answers in order, from one operation on', () => {
    expect(dialogAnswers(ops)).toEqual([
      { accept: true },
      { accept: false },
      { accept: true, text: 'Ann' },
    ]);
    // A retry from the second click leaves out the first dialog.
    expect(dialogAnswers(ops, 2)).toEqual([{ accept: false }, { accept: true, text: 'Ann' }]);
  });
});

describe('runOps', () => {
  const ops: Op[] = [action('a'), action('b'), action('c')];

  it('starts at an operation, and tells which one failed', async () => {
    const done: string[] = [];
    const exec = async (op: Op) => {
      const name: string = op.type === 'action' ? op.action.label : '';
      if (name === 'b' && !done.includes('retry')) {
        done.push('retry');
        throw new Error('b broke');
      }
      done.push(name);
    };
    const first = await runOps(ops, 0, exec);
    expect(first).toEqual({ ok: false, opIndex: 1, message: 'b broke' });
    // Retry from the failed operation. "a" does not run again.
    expect(await runOps(ops, first.ok ? 0 : first.opIndex, exec)).toEqual({ ok: true });
    expect(done).toEqual(['a', 'retry', 'b', 'c']);
  });

  it('stops when asked', async () => {
    const stop = new AbortController();
    const exec = async () => stop.abort();
    expect(await runOps(ops, 0, exec, stop.signal)).toEqual({
      ok: false,
      opIndex: 1,
      message: 'The replay stopped.',
      stopped: true,
    });
  });
});

describe('opsByStep', () => {
  it('finds the operations of a step by its id', () => {
    const step = { id: 'add-mug', index: 1, title: 'Add', status: 'pass' } as never;
    const map = opsByStep({ steps: [{ step, ops: [] }], missingSelectors: [] });
    expect(map.get('add-mug')?.step).toBe(step);
  });
});
