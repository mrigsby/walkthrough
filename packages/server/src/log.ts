// Logs go to stderr. Stdout is only for MCP messages.

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

export const log = {
  debug: (message: string, extra?: unknown) => write('debug', message, extra),
  info: (message: string, extra?: unknown) => write('info', message, extra),
  warn: (message: string, extra?: unknown) => write('warn', message, extra),
  error: (message: string, extra?: unknown) => write('error', message, extra),
};
