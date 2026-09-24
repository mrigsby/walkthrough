import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Starts the demo shop on a port the system picks, so two test files never share one.
export async function startDemoServer(): Promise<{ base: string; port: number; stop: () => void }> {
  const child: ChildProcess = spawn(
    process.execPath,
    [join(repoRoot, 'scripts/demo-server.mjs'), '--port', '0'],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  const base = await new Promise<string>((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Demo server did not start')), 10_000);
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      const match = /http:\/\/localhost:(\d+)/.exec(output);
      if (match) {
        clearTimeout(timer);
        resolve(match[0]);
      }
    });
    child.on('exit', () => reject(new Error('Demo server stopped before it started')));
  });
  // Keep reading output, so the server never waits on a full pipe.
  child.stdout?.resume();
  return { base, port: Number(new URL(base).port), stop: () => child.kill() };
}

// A free port for Chrome's debug connection in tests.
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      server.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}
