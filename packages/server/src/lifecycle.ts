import { log } from './log.js';

// Cleanup steps to run when the server stops.
const cleanups = new Set<() => void | Promise<void>>();
let stopping: Promise<never> | undefined;

export function onShutdown(fn: () => void | Promise<void>): () => void {
  cleanups.add(fn);
  return () => cleanups.delete(fn);
}

// Runs every cleanup step once, then exits. Later calls wait for the same run.
export function shutdown(code = 0, reason = 'stop'): Promise<never> {
  stopping ??= (async () => {
    log.debug(`shutting down (${reason}), ${cleanups.size} cleanup step(s)`);
    for (const fn of cleanups) {
      try {
        await Promise.race([fn(), new Promise((resolve) => setTimeout(resolve, 3000))]);
      } catch (error) {
        log.warn('cleanup step failed', error);
      }
    }
    process.exit(code);
  })();
  return stopping;
}

// Stop cleanly when the client goes away or the process is told to stop.
export function installShutdownHandlers(): void {
  process.stdin.on('end', () => void shutdown(0, 'stdin end'));
  process.stdin.on('close', () => void shutdown(0, 'stdin close'));
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
    process.on(signal, () => void shutdown(0, signal));
  }
}
