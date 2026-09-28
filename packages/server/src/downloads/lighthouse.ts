import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ToolError } from '../errors.js';
import { CACHE_DIR, SELF } from './cache.js';

// The Lighthouse version that Walkthrough is tested with.
export const LIGHTHOUSE_VERSION = '13.5.0';

export const LIGHTHOUSE_MISSING = `Lighthouse is not installed. To install it (about 170 MB), run: ${SELF} setup lighthouse`;

// The parts of the Lighthouse module that Walkthrough uses.
export interface LighthouseModule {
  default: (...args: unknown[]) => Promise<unknown>;
  startFlow: (...args: unknown[]) => Promise<unknown>;
  auditFlowArtifacts: (...args: unknown[]) => Promise<unknown>;
  generateReport: (result: unknown, format: string) => string;
  desktopConfig: unknown;
}

export function lighthouseDir(cacheDir = CACHE_DIR): string {
  return join(cacheDir, 'lighthouse', LIGHTHOUSE_VERSION);
}

function entryFile(dir: string): string {
  return join(dir, 'node_modules', 'lighthouse', 'core', 'index.js');
}

// Finds the installed copy. Only the tested version counts.
export function findLighthouse(cacheDir = CACHE_DIR): { dir: string; version: string } | undefined {
  const dir = lighthouseDir(cacheDir);
  try {
    const pkg = JSON.parse(
      readFileSync(join(dir, 'node_modules', 'lighthouse', 'package.json'), 'utf8'),
    ) as { version?: string };
    if (pkg.version === LIGHTHOUSE_VERSION && existsSync(entryFile(dir))) {
      return { dir, version: pkg.version };
    }
  } catch {}
  return undefined;
}

// Installs the tested version with npm. npm checks the package hashes. No install scripts run.
export async function installLighthouse(
  options: { cacheDir?: string; npm?: string; onOutput?: (text: string) => void } = {},
): Promise<string> {
  const dir = lighthouseDir(options.cacheDir);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const windows = process.platform === 'win32';
  const args = [
    'install',
    '--prefix',
    dir,
    `lighthouse@${LIGHTHOUSE_VERSION}`,
    '--omit=dev',
    '--ignore-scripts',
    '--no-audit',
    '--no-fund',
    '--loglevel=error',
  ];
  // Windows runs npm.cmd through a shell, so paths with spaces need quotes.
  const shellArgs = windows ? args.map((a) => (/\s/.test(a) ? `"${a}"` : a)) : args;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.npm ?? (windows ? 'npm.cmd' : 'npm'), shellArgs, {
      cwd: dir,
      shell: windows,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output += chunk.toString();
      options.onOutput?.(chunk.toString());
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error: NodeJS.ErrnoException) => {
      reject(
        new ToolError(
          error.code === 'ENOENT'
            ? 'Walkthrough did not find npm. Walkthrough uses npm to install Lighthouse. Install Node.js with npm, and try again.'
            : `npm did not start: ${error.message}`,
          'download_failed',
        ),
      );
    });
    child.on('close', (code) => {
      if (code === 0) resolve();
      else
        reject(
          new ToolError(
            `npm could not install Lighthouse (exit code ${code}). ${output.trim().slice(-600)}`,
            'download_failed',
          ),
        );
    });
  });
  if (!findLighthouse(options.cacheDir)) {
    throw new ToolError(`npm finished, but Lighthouse is not in ${dir}.`, 'download_failed');
  }
  return dir;
}

const loaded = new Map<string, Promise<LighthouseModule>>();

// Loads Lighthouse from the cache. It is never part of the bundle.
export function loadLighthouse(cacheDir = CACHE_DIR): Promise<LighthouseModule> {
  const found = findLighthouse(cacheDir);
  if (!found) return Promise.reject(new ToolError(LIGHTHOUSE_MISSING, 'lighthouse_missing'));
  const file = entryFile(found.dir);
  let module = loaded.get(file);
  if (!module) {
    module = import(pathToFileURL(file).href) as Promise<LighthouseModule>;
    loaded.set(file, module);
  }
  return module;
}
