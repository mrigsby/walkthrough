import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkRunId, RunStore } from '../../src/run/run-store.js';
import { tempDir } from '../helpers/temp.js';

// A project with one real run, and a decoy run.json outside the runs folder.
function project(): string {
  const dir = tempDir('run-ids');
  mkdirSync(join(dir, '.walkthrough', 'runs', 'good-run'), { recursive: true });
  writeFileSync(join(dir, '.walkthrough', 'runs', 'good-run', 'run.json'), '{"steps":[]}');
  mkdirSync(join(dir, 'decoy'), { recursive: true });
  writeFileSync(join(dir, 'decoy', 'run.json'), '{"steps":[]}');
  return dir;
}

describe('run ids', () => {
  it('opens a real run', () => {
    const dir = project();
    expect(RunStore.open(dir, 'good-run').run.steps).toEqual([]);
  });

  it('refuses names that leave the runs folder', () => {
    const dir = project();
    for (const id of ['../../decoy', '..', 'a/../../decoy', '/etc', '.hidden', 'a\\b']) {
      expect(() => checkRunId(dir, id), id).toThrow(
        expect.objectContaining({ code: 'bad_run_id' }),
      );
    }
  });

  it('refuses a link that points outside the runs folder', () => {
    const dir = project();
    symlinkSync(join(dir, 'decoy'), join(dir, '.walkthrough', 'runs', 'linked'));
    expect(() => RunStore.open(dir, 'linked')).toThrow(
      expect.objectContaining({ code: 'bad_run_id' }),
    );
  });

  it('says a missing run is not found', () => {
    const dir = project();
    expect(() => RunStore.open(dir, 'nope')).toThrow(
      expect.objectContaining({ code: 'run_not_found' }),
    );
    expect(() => RunStore.open(tempDir('empty'), 'nope')).toThrow(
      expect.objectContaining({ code: 'run_not_found' }),
    );
  });
});
