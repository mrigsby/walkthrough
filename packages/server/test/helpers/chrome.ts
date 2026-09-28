import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import puppeteer, { type Browser, type ConnectOptions } from 'puppeteer-core';
import { tempDir } from './temp.js';

// A file for UIWALK_DEBUG_ENDPOINT_FILE. The server writes the exact address of its Chrome
// there, so a test never connects to the Chrome of another test.
export function endpointFile(): string {
  return join(tempDir('endpoint'), 'chrome');
}

// Connects to the server's Chrome. Read the file each time: a new browser writes a new address.
export function connectChrome(file: string, options: ConnectOptions = {}): Promise<Browser> {
  return puppeteer.connect({ ...options, browserWSEndpoint: readFileSync(file, 'utf8') });
}
