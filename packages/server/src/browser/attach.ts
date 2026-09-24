import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser } from 'puppeteer-core';
import { ToolError } from '../errors.js';

// Reads the port file that Chrome writes in its profile folder.
function endpointFromProfile(dir: string): string {
  const file = join(dir, 'DevToolsActivePort');
  if (!existsSync(file)) {
    throw new ToolError(
      `No DevToolsActivePort file in ${dir}. Start Chrome with --remote-debugging-port=9222 and --user-data-dir=${dir}.`,
      'attach_failed',
    );
  }
  const [port, path] = readFileSync(file, 'utf8').trim().split('\n');
  return `ws://127.0.0.1:${port}${path}`;
}

// Connects to a Chrome that is already running.
// Target: an http URL (http://127.0.0.1:9222), a ws URL, or a Chrome profile folder.
export async function attachChrome(target: string): Promise<Browser> {
  try {
    if (/^https?:\/\//.test(target)) return await puppeteer.connect({ browserURL: target });
    if (/^wss?:\/\//.test(target)) return await puppeteer.connect({ browserWSEndpoint: target });
    if (existsSync(target) && statSync(target).isDirectory()) {
      return await puppeteer.connect({ browserWSEndpoint: endpointFromProfile(target) });
    }
  } catch (error) {
    if (error instanceof ToolError) throw error;
    throw new ToolError(
      `Could not connect to Chrome at ${target}: ${(error as Error).message}. Start Chrome with --remote-debugging-port=9222 and a separate --user-data-dir. See docs/troubleshooting.md.`,
      'attach_failed',
    );
  }
  throw new ToolError(
    `"${target}" is not a Chrome address. Use a URL like http://127.0.0.1:9222 or a Chrome profile folder.`,
    'attach_failed',
  );
}
