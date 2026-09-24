import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const made: string[] = [];

// Makes a temp folder that is removed after the test file ends.
export function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), `uiwalk-${prefix}-`));
  made.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of made.splice(0)) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});
