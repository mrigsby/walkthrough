import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  FFMPEG_BUILDS,
  type FfmpegBuild,
  ffmpegDir,
  findFfmpeg,
  installFfmpeg,
  licenseName,
  platformKey,
} from '../../src/downloads/ffmpeg.js';
import {
  findLighthouse,
  installLighthouse,
  LIGHTHOUSE_VERSION,
  lighthouseDir,
  loadLighthouse,
} from '../../src/downloads/lighthouse.js';
import { tempDir } from '../helpers/temp.js';

const posix = process.platform !== 'win32';

// A tiny program that prints a license, like "ffmpeg -L" does.
const FAKE_FFMPEG = `#!/bin/sh
echo "ffmpeg is free software; you can redistribute it under the terms of the GNU General Public License"
echo "as published by the Free Software Foundation; either version 3 of the License"
`;

describe('ffmpeg download', () => {
  let server: Server;
  let base: string;
  const gz = gzipSync(Buffer.from(FAKE_FFMPEG));

  beforeAll(async () => {
    server = createServer((req, res) => {
      if (req.url === '/ffmpeg-test.gz') return res.end(gz);
      res.statusCode = 404;
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  afterAll(() => server?.close());

  const build = (sha256: string): FfmpegBuild => ({
    id: 'test',
    url: `${base}/ffmpeg-test.gz`,
    sha256,
    archive: 'gz',
    source: 'a test server',
  });

  it.skipIf(!posix)('saves the program, its license, and where it came from', async () => {
    const cacheDir = tempDir('ffmpeg-ok');
    const good = createHash('sha256').update(gz).digest('hex');
    const result = await installFfmpeg({ cacheDir, build: build(good) });
    expect(result.path).toBe(join(cacheDir, 'ffmpeg', 'test', 'ffmpeg'));
    expect(statSync(result.path).mode & 0o111).not.toBe(0);
    expect(result.license).toBe('GPL v3');
    expect(readFileSync(join(cacheDir, 'ffmpeg', 'test', 'LICENSE.txt'), 'utf8')).toMatch(
      /General Public License/,
    );
    expect(readFileSync(join(cacheDir, 'ffmpeg', 'test', 'SOURCE.txt'), 'utf8')).toContain(good);
  });

  it('refuses a download with the wrong hash', async () => {
    const cacheDir = tempDir('ffmpeg-bad');
    await expect(installFfmpeg({ cacheDir, build: build('0'.repeat(64)) })).rejects.toThrow(
      /SHA-256/,
    );
    expect(existsSync(join(cacheDir, 'ffmpeg', 'test'))).toBe(false);
  });

  it('pins a hash for each download', () => {
    for (const [key, entry] of Object.entries(FFMPEG_BUILDS)) {
      expect(entry.sha256, key).toMatch(/^[0-9a-f]{64}$/);
      expect(entry.url, key).toMatch(/^https:\/\//);
    }
  });

  it('names the license', () => {
    expect(licenseName('GNU Lesser General Public License')).toBe('LGPL');
    expect(licenseName('GNU General Public License ... version 2')).toBe('GPL');
    expect(licenseName('nothing')).toBe('see LICENSE.txt');
  });
});

describe('findFfmpeg', () => {
  it('refuses a config path that does not exist', () => {
    expect(() => findFfmpeg({ configPath: '/no/such/ffmpeg', env: {} })).toThrow(/ffmpegPath/);
  });

  it.skipIf(!posix)('looks at the setting, the variable, the PATH, then the download', () => {
    const dir = tempDir('ffmpeg-find');
    const make = (path: string) => {
      mkdirSync(join(path, '..'), { recursive: true });
      writeFileSync(path, FAKE_FFMPEG);
      chmodSync(path, 0o755);
      return path;
    };
    const config = make(join(dir, 'config', 'ffmpeg'));
    const variable = make(join(dir, 'env', 'ffmpeg'));
    const onPath = make(join(dir, 'bin', 'ffmpeg'));
    const cacheDir = join(dir, 'cache');
    const build = FFMPEG_BUILDS[platformKey()];
    expect(findFfmpeg({ configPath: config, env: { UIWALK_FFMPEG: variable } })).toEqual({
      path: config,
      source: 'config',
    });
    expect(findFfmpeg({ env: { UIWALK_FFMPEG: variable, PATH: join(dir, 'bin') } })?.source).toBe(
      'env',
    );
    expect(findFfmpeg({ env: { PATH: join(dir, 'bin') } })).toEqual({
      path: onPath,
      source: 'system',
    });
    expect(findFfmpeg({ env: { PATH: '' }, cacheDir })).toBeUndefined();
    if (build) {
      const downloaded = make(join(ffmpegDir(build, cacheDir), 'ffmpeg'));
      expect(findFfmpeg({ env: { PATH: '' }, cacheDir })).toEqual({
        path: downloaded,
        source: 'downloaded',
      });
    }
  });
});

describe('Lighthouse download', () => {
  // Writes a fake Lighthouse package where npm would put it.
  function fakeLighthouse(cacheDir: string, version = LIGHTHOUSE_VERSION): void {
    const pkg = join(lighthouseDir(cacheDir), 'node_modules', 'lighthouse');
    mkdirSync(join(pkg, 'core'), { recursive: true });
    writeFileSync(join(pkg, 'package.json'), JSON.stringify({ version, type: 'module' }));
    writeFileSync(
      join(pkg, 'core', 'index.js'),
      "export default async () => 'ran';\nexport const startFlow = async () => 'flow';\nexport const desktopConfig = { desktop: true };\n",
    );
  }

  it('finds and loads only the tested version', async () => {
    const cacheDir = tempDir('lh-find');
    expect(findLighthouse(cacheDir)).toBeUndefined();
    await expect(loadLighthouse(cacheDir)).rejects.toThrow(/setup lighthouse/);
    fakeLighthouse(cacheDir, '1.0.0');
    expect(findLighthouse(cacheDir)).toBeUndefined();
    fakeLighthouse(cacheDir);
    expect(findLighthouse(cacheDir)?.version).toBe(LIGHTHOUSE_VERSION);
    const lighthouse = await loadLighthouse(cacheDir);
    expect(await lighthouse.default()).toBe('ran');
    expect(lighthouse.desktopConfig).toEqual({ desktop: true });
  });

  it.skipIf(!posix)('installs with npm and no install scripts', async () => {
    const cacheDir = tempDir('lh-install');
    const log = join(cacheDir, 'npm-args.txt');
    // A fake npm: it saves its arguments and writes the package into --prefix.
    const npm = join(cacheDir, 'fake-npm');
    writeFileSync(
      npm,
      `#!/bin/sh
echo "$@" > "${log}"
mkdir -p "$3/node_modules/lighthouse/core"
echo '{"version":"${LIGHTHOUSE_VERSION}","type":"module"}' > "$3/node_modules/lighthouse/package.json"
echo 'export default async () => 1;' > "$3/node_modules/lighthouse/core/index.js"
`,
    );
    chmodSync(npm, 0o755);
    const dir = await installLighthouse({ cacheDir, npm });
    expect(dir).toBe(lighthouseDir(cacheDir));
    const args = readFileSync(log, 'utf8');
    expect(args).toContain(`lighthouse@${LIGHTHOUSE_VERSION}`);
    expect(args).toContain('--ignore-scripts');
    expect(args).toContain('--omit=dev');
  });

  it('explains a missing npm', async () => {
    await expect(
      installLighthouse({ cacheDir: tempDir('lh-no-npm'), npm: '/no/such/npm' }),
    ).rejects.toThrow(/did not find npm/);
  });
});
