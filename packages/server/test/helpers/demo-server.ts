import { type ChildProcess, spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

// Starts the demo shop on a free port for a test.
export async function startDemoServer(): Promise<{ base: string; port: number; stop: () => void }> {
  const port = 4400 + Math.floor(Math.random() * 500);
  const base = `http://localhost:${port}`;
  const child: ChildProcess = spawn(
    process.execPath,
    [join(repoRoot, 'scripts/demo-server.mjs'), '--port', String(port)],
    { stdio: 'ignore' },
  );
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`${base}/api/products`)).ok) return { base, port, stop: () => child.kill() };
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('Demo server did not start');
}
