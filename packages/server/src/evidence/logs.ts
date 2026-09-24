import type { ConsoleMessage, HTTPRequest, HTTPResponse, Page } from 'puppeteer-core';
import { scrubText, scrubUrl } from './scrub.js';

export type LogLevel = 'error' | 'warning' | 'info';
export type LogKind = 'console' | 'page-error' | 'network';

export interface LogEntry {
  seq: number;
  at: string;
  tabId: string;
  step?: string;
  kind: LogKind;
  level: LogLevel;
  text: string;
}

const MAX_ENTRIES = 1000;

function consoleLevel(message: ConsoleMessage): LogLevel {
  const type = message.type();
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warn') return 'warning';
  return 'info';
}

// Keeps recent console messages, page errors, and failed requests from all tabs.
export class LogBook {
  private entries: LogEntry[] = [];
  private seq = 0;
  private stepStart = 0;

  get marker(): number {
    return this.seq;
  }

  private add(entry: Omit<LogEntry, 'seq' | 'at'>): void {
    this.seq += 1;
    this.entries.push({
      ...entry,
      seq: this.seq,
      at: new Date().toISOString(),
      text: scrubText(entry.text),
    });
    if (this.entries.length > MAX_ENTRIES) this.entries.shift();
  }

  attach(page: Page, tabId: string): void {
    page.on('console', (message: ConsoleMessage) => {
      const where = message.location()?.url;
      const text =
        message.text() + (where && consoleLevel(message) !== 'info' ? ` (${scrubUrl(where)})` : '');
      this.add({ tabId, kind: 'console', level: consoleLevel(message), text });
    });
    page.on('pageerror', (error: unknown) => {
      const err = error as Error;
      const firstFrame = err?.stack?.split('\n').find((line) => line.trim().startsWith('at '));
      const text = `${err?.name ?? 'Error'}: ${err?.message ?? String(error)}${firstFrame ? ` ${firstFrame.trim()}` : ''}`;
      this.add({ tabId, kind: 'page-error', level: 'error', text });
    });
    page.on('requestfailed', (request: HTTPRequest) => {
      const reason = request.failure()?.errorText ?? 'failed';
      // A canceled page load is normal when the page changes.
      if (reason === 'net::ERR_ABORTED') return;
      this.add({
        tabId,
        kind: 'network',
        level: 'error',
        text: `${request.method()} ${scrubUrl(request.url())} failed: ${reason}`,
      });
    });
    page.on('response', (response: HTTPResponse) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (/\/favicon\.ico(\?|$)/.test(url)) return;
      this.add({
        tabId,
        kind: 'network',
        level: status >= 500 ? 'error' : 'warning',
        text: `${response.request().method()} ${scrubUrl(url)} returned HTTP ${status}`,
      });
    });
  }

  // Entries after a marker, filtered by level.
  since(marker: number, levels: LogLevel[] = ['error', 'warning']): LogEntry[] {
    return this.entries.filter((e) => e.seq > marker && levels.includes(e.level));
  }

  // Entries since the current step started.
  currentStep(levels?: LogLevel[]): LogEntry[] {
    return this.since(this.stepStart, levels);
  }

  // Ends the current step: tags its entries and starts the next step.
  endStep(label: string): void {
    for (const entry of this.entries) {
      if (entry.seq > this.stepStart && !entry.step) entry.step = label;
    }
    this.stepStart = this.seq;
  }
}

export function formatLogs(entries: LogEntry[]): string {
  if (entries.length === 0) return '(none)';
  return entries
    .map(
      (e) =>
        `#${e.seq} [${e.level}] ${e.kind} in ${e.tabId}${e.step ? `, step "${e.step}"` : ''}: ${e.text}`,
    )
    .join('\n');
}
