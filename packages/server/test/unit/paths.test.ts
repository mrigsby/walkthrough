import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkUploadPath } from '../../src/guards/paths.js';
import { tempDir } from '../helpers/temp.js';

let root: string;
let outside: string;

beforeAll(() => {
  root = tempDir('paths');
  mkdirSync(join(root, 'fixtures'));
  mkdirSync(join(root, '.walkthrough', 'sessions'), { recursive: true });
  writeFileSync(join(root, 'fixtures', 'photo.png'), 'x');
  writeFileSync(join(root, '.walkthrough', '.env'), 'A=b');
  writeFileSync(join(root, '.walkthrough', 'sessions', 'me.json'), '{}');
  writeFileSync(join(root, 'config.local.yaml'), 'x: 1');
  outside = tempDir('outside');
  writeFileSync(join(outside, 'outside.txt'), 'x');
  symlinkSync(join(outside, 'outside.txt'), join(root, 'fixtures', 'link.txt'));
});

describe('checkUploadPath', () => {
  it('allows a normal file in the project', () => {
    expect(checkUploadPath('fixtures/photo.png', root, root)).toMatch(/photo\.png$/);
  });

  it('blocks secrets and hidden files', () => {
    expect(() => checkUploadPath('.walkthrough/.env', root, root)).toThrow(/hidden or private/);
    expect(() => checkUploadPath('.walkthrough/sessions/me.json', root, root)).toThrow(
      /hidden or private/,
    );
    expect(() => checkUploadPath('config.local.yaml', root, root)).toThrow(/hidden or private/);
  });

  it('blocks files outside the project, even through a link', () => {
    expect(() => checkUploadPath(join(outside, 'outside.txt'), root, root)).toThrow(
      /only upload files inside/,
    );
    expect(() => checkUploadPath('fixtures/link.txt', root, root)).toThrow(
      /only upload files inside/,
    );
    expect(() => checkUploadPath('../x', root, root)).toThrow(/does not exist|only upload/);
  });

  it('explains a missing file', () => {
    expect(() => checkUploadPath('fixtures/none.png', root, root)).toThrow(/does not exist/);
  });
});
