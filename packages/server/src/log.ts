// Logs go to stderr. Stdout is only for MCP messages.
import { appendFileSync } from 'node:fs';

type Level = 'debug' | 'info' | 'warn' | 'error';

const order: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function currentLevel(): Level {
  const value = process.env.UIWALK_LOG_LEVEL;
  return value === 'debug' || value === 'warn' || value === 'error' ? value : 'info';
}

function write(level: Level, message: string, extra?: unknown): void {
  if (order[level] < order[currentLevel()]) return;
  const line = `[uiwalk] ${level}: ${message}`;
  if (extra === undefined) console.error(line);
  else console.error(line, extra);
}

// For debugging: with UIWALK_TRACE_FILE set, each event is written as one JSON line.
export function trace(event: string, data: Record<string, unknown>): void {
  const file = process.env.UIWALK_TRACE_FILE;
  if (!file) return;
  try {
    appendFileSync(
      file,
      `${JSON.stringify({ at: new Date().toISOString(), pid: process.pid, event, ...data })}\n`,
    );
  } catch {}
}

export const log = {
  debug: (message: string, extra?: unknown) => write('debug', message, extra),
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra),
};
