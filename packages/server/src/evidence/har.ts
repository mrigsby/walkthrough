import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Context } from '../context.js';
import { MASK, type SecretStore } from '../guards/secrets.js';
import { fileStamp } from '../project-files.js';
import { VERSION } from '../version.js';
import { maskBody, type NetEntry, SECRET_HEADER } from './network.js';
import { scrubText, scrubUrl } from './scrub.js';

type Header = { name: string; value: string };

// HAR files are shared, so login headers and secret body fields are always removed.
function headers(
  values: Record<string, string> | undefined,
  clean: (t: string) => string,
): Header[] {
  return Object.entries(values ?? {}).map(([name, value]) => ({
    name,
    value: SECRET_HEADER.test(name) ? MASK : clean(value),
  }));
}

// Timing parts in milliseconds, from Chrome's resource timing. -1 means not known.
function timings(entry: NetEntry): Record<string, number> {
  const total = entry.endedAt ? entry.endedAt - entry.startedAt : 0;
  const t = entry.timing;
  if (!t) return { blocked: -1, dns: -1, connect: -1, ssl: -1, send: 0, wait: total, receive: 0 };
  const span = (start: number, end: number) => (start >= 0 && end >= 0 ? end - start : -1);
  const wait = span(t.sendEnd, t.receiveHeadersEnd);
  const before = Math.max(0, t.sendEnd);
  return {
    blocked: -1,
    dns: span(t.dnsStart, t.dnsEnd),
    connect: span(t.connectStart, t.connectEnd),
    ssl: span(t.sslStart, t.sslEnd),
    send: Math.max(0, span(t.sendStart, t.sendEnd)),
    wait: Math.max(0, wait),
    receive: Math.max(0, total - before - Math.max(0, wait)),
  };
}

// A HAR 1.2 file that DevTools and other tools can open.
export function toHar(entries: NetEntry[], secrets?: SecretStore): Record<string, unknown> {
  const clean = (text: string) => scrubText(secrets ? secrets.redact(text) : text);
  return {
    log: {
      version: '1.2',
      creator: { name: 'Walkthrough', version: VERSION },
      pages: [],
      entries: entries.map((entry) => {
        // The scrubbed address already has **** for secret query values.
        const url = new URL(scrubUrl(entry.url));
        const requestMime = entry.requestHeaders['content-type']?.split(';')[0]?.trim();
        return {
          startedDateTime: new Date(entry.startedAt).toISOString(),
          time: entry.endedAt ? entry.endedAt - entry.startedAt : 0,
          request: {
            method: entry.method,
            url: scrubUrl(entry.url),
            httpVersion: 'HTTP/1.1',
            headers: headers(entry.requestHeaders, clean),
            queryString: [...url.searchParams].map(([name, value]) => ({ name, value })),
            cookies: [],
            headersSize: -1,
            bodySize: entry.postData ? Buffer.byteLength(entry.postData) : 0,
            ...(entry.postData
              ? {
                  postData: {
                    mimeType: requestMime ?? 'text/plain',
                    text: clean(maskBody(entry.postData, requestMime)),
                  },
                }
              : {}),
          },
          response: {
            status: entry.status ?? 0,
            statusText: entry.failure ?? entry.statusText ?? '',
            httpVersion: 'HTTP/1.1',
            headers: headers(entry.responseHeaders, clean),
            cookies: [],
            content: {
              size: entry.size ?? -1,
              mimeType: entry.mimeType ?? 'x-unknown',
              ...(entry.body !== undefined
                ? { text: clean(maskBody(entry.body, entry.mimeType)) }
                : {}),
              ...(entry.bodyNote ? { comment: entry.bodyNote } : {}),
            },
            redirectURL: scrubUrl(entry.responseHeaders?.location ?? ''),
            headersSize: -1,
            bodySize: entry.size ?? -1,
          },
          cache: {},
          timings: timings(entry),
          ...(entry.remoteAddress ? { serverIPAddress: entry.remoteAddress } : {}),
          _resourceType: entry.type,
          _tab: entry.tabId,
        };
      }),
    },
  };
}

// Where HAR files go: next to the screenshots of the run, or of today.
export function networkDir(ctx: Context, projectDir: string): string {
  return join(dirname(ctx.evidenceDir(projectDir)), 'network');
}

// Writes a HAR file and returns its path.
export function writeHar(
  dir: string,
  label: string,
  entries: NetEntry[],
  secrets?: SecretStore,
): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${fileStamp(label)}.har`);
  writeFileSync(file, `${JSON.stringify(toHar(entries, secrets), null, 2)}\n`);
  return file;
}
