import { mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { checkScreenshotPath, checkUploadPath } from '../../src/guards/paths.js';
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

describe('checkScreenshotPath', () => {
  it('allows a new file in a new folder of the project', () => {
    const shot = checkScreenshotPath('docs/images/help/cart.png', root, []);
    expect(shot.display).toBe(join('docs', 'images', 'help', 'cart.png'));
    expect(shot.path.endsWith(join('docs', 'images', 'help', 'cart.png'))).toBe(true);
    expect(checkScreenshotPath('fixtures/photo.png', root).display).toBe(
      join('fixtures', 'photo.png'),
    );
  });

  it('allows only image files', () => {
    expect(checkScreenshotPath('a.JPG', root).display).toBe('a.JPG');
    expect(checkScreenshotPath('a.webp', root).display).toBe('a.webp');
    expect(() => checkScreenshotPath('notes.txt', root)).toThrow(/End the screenshot path/);
    expect(() => checkScreenshotPath('fixtures', root)).toThrow(/End the screenshot path/);
  });

  it('blocks hidden folders', () => {
    expect(() => checkScreenshotPath('.git/x.png', root)).toThrow(/hidden/);
    expect(() => checkScreenshotPath('.walkthrough/x.png', root)).toThrow(/hidden/);
  });

  it('blocks paths outside the project, even through a link', () => {
    expect(() => checkScreenshotPath('../x.png', root)).toThrow(/only in the project folder/);
    expect(() => checkScreenshotPath(join(outside, 'x.png'), root)).toThrow(/screenshotRoots/);
    symlinkSync(outside, join(root, 'out-link'));
    expect(() => checkScreenshotPath('out-link/x.png', root)).toThrow(/only in the project folder/);
  });

  it('allows a folder from screenshotRoots', () => {
    const shot = checkScreenshotPath(join(outside, 'help', 'x.png'), root, [outside]);
    expect(shot.display).toBe(shot.path);
    expect(shot.path.endsWith(join('help', 'x.png'))).toBe(true);
  });
});
