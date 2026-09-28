import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { ToolError } from '../errors.js';
import { CACHE_DIR, SELF } from './cache.js';

// One ffmpeg download for one kind of computer. The hash is checked before use.
export interface FfmpegBuild {
  id: string;
  url: string;
  sha256: string;
  archive: 'gz' | 'zip';
  source: string;
}

const MAC_SOURCE =
  "Martin Riedl's FFmpeg build server (https://ffmpeg.martin-riedl.de). Signed by the builder.";
const STATIC_SOURCE = 'ffmpeg-static release b6.1.1 (https://github.com/eugeneware/ffmpeg-static)';
const STATIC_URL = 'https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1';

// Pinned builds. Change the URL and the hash together.
export const FFMPEG_BUILDS: Record<string, FfmpegBuild> = {
  'darwin-arm64': {
    id: '9.0.2',
    url: 'https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip',
    sha256: 'c8ed4c4e6978a03c485edbfe4e0a5dc2380f8a30bba5150531b31b094492d924',
    archive: 'zip',
    source: MAC_SOURCE,
  },
  'darwin-x64': {
    id: '9.0.2',
    url: 'https://ffmpeg.martin-riedl.de/download/macos/amd64/1789931006_9.0.2/ffmpeg.zip',
    sha256: '7c6b4125b191cbf773832dc51f424cf2b6bb7da43007d1e066f95909e47cacd4',
    archive: 'zip',
    source: MAC_SOURCE,
  },
  'linux-x64': {
    id: 'b6.1.1',
    url: `${STATIC_URL}/ffmpeg-linux-x64.gz`,
    sha256: 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa',
    archive: 'gz',
    source: STATIC_SOURCE,
  },
  'linux-arm64': {
    id: 'b6.1.1',
    url: `${STATIC_URL}/ffmpeg-linux-arm64.gz`,
    sha256: '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0',
    archive: 'gz',
    source: STATIC_SOURCE,
  },
  'win32-x64': {
    id: 'b6.1.1',
    url: `${STATIC_URL}/ffmpeg-win32-x64.gz`,
    sha256: '8883a3dffbd0a16cf4ef95206ea05283f78908dbfb118f73c83f4951dcc06d77',
    archive: 'gz',
    source: STATIC_SOURCE,
  },
};

export interface FfmpegInfo {
  path: string;
  source: 'config' | 'env' | 'system' | 'downloaded';
}

export const FFMPEG_MISSING = `Walkthrough did not find ffmpeg. To download it, run: ${SELF} setup ffmpeg. You can also install ffmpeg yourself.`;

const binName = () => (process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg');

export function platformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function ffmpegDir(build: FfmpegBuild, cacheDir = CACHE_DIR): string {
  return join(cacheDir, 'ffmpeg', build.id);
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

// Finds ffmpeg: the local setting, then UIWALK_FFMPEG, then the PATH, then our download.
export function findFfmpeg(
  options: { configPath?: string; env?: NodeJS.ProcessEnv; cacheDir?: string } = {},
): FfmpegInfo | undefined {
  const env = options.env ?? process.env;
  if (options.configPath) {
    if (!isFile(options.configPath)) {
      throw new ToolError(
        `Walkthrough did not find ffmpeg at ${options.configPath}. This path comes from "ffmpegPath" in config.local.yaml. Fix the path or remove the setting.`,
        'ffmpeg_missing',
      );
    }
    return { path: options.configPath, source: 'config' };
  }
  if (env.UIWALK_FFMPEG && isFile(env.UIWALK_FFMPEG))
    return { path: env.UIWALK_FFMPEG, source: 'env' };
  for (const dir of (env.PATH ?? '').split(delimiter)) {
    if (!dir) continue;
    const candidate = join(dir, binName());
    if (isFile(candidate)) return { path: candidate, source: 'system' };
  }
  const build = FFMPEG_BUILDS[platformKey()];
  if (build) {
    const downloaded = join(ffmpegDir(build, options.cacheDir), binName());
    if (isFile(downloaded)) return { path: downloaded, source: 'downloaded' };
  }
  return undefined;
}

async function download(url: string, onProgress?: (percent: number) => void): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetch(url);
  } catch (error) {
    throw new ToolError(
      `Could not download ${url}: ${(error as Error).message}`,
      'download_failed',
    );
  }
  if (!response.ok || !response.body) {
    throw new ToolError(`Could not download ${url}: HTTP ${response.status}`, 'download_failed');
  }
  const total = Number(response.headers.get('content-length')) || 0;
  const chunks: Uint8Array[] = [];
  let done = 0;
  let last = -1;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    done += chunk.byteLength;
    const percent = total ? Math.floor((done / total) * 100) : 0;
    if (total && percent !== last && percent % 10 === 0) {
      last = percent;
      onProgress?.(percent);
    }
  }
  return Buffer.concat(chunks);
}

// Downloads the pinned ffmpeg for this computer, checks its hash, and saves its license.
export async function installFfmpeg(
  options: { cacheDir?: string; build?: FfmpegBuild; onProgress?: (percent: number) => void } = {},
): Promise<{ path: string; build: FfmpegBuild; license: string }> {
  const build = options.build ?? FFMPEG_BUILDS[platformKey()];
  if (!build) {
    throw new ToolError(
      `Walkthrough has no ffmpeg download for this computer (${platformKey()}). Install ffmpeg yourself. If it is not on the PATH, set "ffmpegPath" in .walkthrough/config.local.yaml.`,
      'download_failed',
    );
  }
  const data = await download(build.url, options.onProgress);
  const hash = createHash('sha256').update(data).digest('hex');
  if (hash !== build.sha256) {
    throw new ToolError(
      `The ffmpeg download from ${build.url} does not match its expected SHA-256 hash, so Walkthrough did not use it. Try again later, or install ffmpeg yourself.`,
      'download_failed',
    );
  }
  const dir = ffmpegDir(build, options.cacheDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const bin = join(dir, binName());
  if (build.archive === 'gz') {
    writeFileSync(bin, gunzipSync(data));
  } else {
    const zip = join(dir, 'download.zip');
    writeFileSync(zip, data);
    try {
      execFileSync(process.platform === 'darwin' ? '/usr/bin/unzip' : 'unzip', [
        '-o',
        '-q',
        zip,
        '-d',
        dir,
      ]);
    } catch (error) {
      throw new ToolError(
        `Could not unzip the ffmpeg download: ${(error as Error).message}`,
        'download_failed',
      );
    } finally {
      rmSync(zip, { force: true });
    }
    if (!existsSync(bin)) {
      throw new ToolError('The ffmpeg download has no ffmpeg program in it.', 'download_failed');
    }
  }
  chmodSync(bin, 0o755);
  // Keep the license text and where the file came from, next to the program.
  let license = '';
  try {
    license = execFileSync(bin, ['-hide_banner', '-L'], { encoding: 'utf8', timeout: 10_000 });
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw new ToolError(
      `The downloaded ffmpeg does not run: ${(error as Error).message}`,
      'download_failed',
    );
  }
  writeFileSync(join(dir, 'LICENSE.txt'), license);
  writeFileSync(
    join(dir, 'SOURCE.txt'),
    `Downloaded by Walkthrough from ${build.url}\nSource: ${build.source}\nSHA-256: ${build.sha256}\n`,
  );
  return { path: bin, build, license: licenseName(license) };
}

// A short name for the license that ffmpeg prints with -L.
export function licenseName(text: string): string {
  if (/Lesser General Public License/i.test(text)) return 'LGPL';
  if (/General Public License/i.test(text)) return /version 3/i.test(text) ? 'GPL v3' : 'GPL';
  return 'see LICENSE.txt';
}
