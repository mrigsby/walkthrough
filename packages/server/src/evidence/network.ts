import type { HTTPRequest, HTTPResponse, Page, Protocol } from 'puppeteer-core';
import { MASK } from '../guards/secrets.js';

// One request, as the network tool and HAR files show it.
export interface NetEntry {
  id: string;
  seq: number;
  tabId: string;
  step?: string;
  method: string;
  url: string;
  type: string;
  startedAt: number;
  endedAt?: number;
  status?: number;
  statusText?: string;
  mimeType?: string;
  size?: number;
  fromCache?: boolean;
  failure?: string;
  remoteAddress?: string;
  timing?: Protocol.Network.ResourceTiming;
  requestHeaders: Record<string, string>;
  postData?: string;
  responseHeaders?: Record<string, string>;
  body?: string;
  // Why there is no body, or why it is short.
  bodyNote?: string;
}

const MAX_ENTRIES = 1000;
const MAX_BODY = 256 * 1024;
const MAX_POST = 64 * 1024;
const BODY_BUDGET = 20 * 1024 * 1024;
// Bodies are kept for these types, while the page still has them.
const BODY_TYPES = new Set(['document', 'xhr', 'fetch']);
const TEXT_MIME =
  /^(text\/|application\/(json|[\w.+-]*\+json|xml|[\w.+-]*\+xml|javascript|x-www-form-urlencoded|graphql))/i;

// Headers that carry logins. Replies mask them, and files always remove them.
export const SECRET_HEADER =
  /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|x-auth-token|x-csrf-token|x-xsrf-token)$|token|secret|api-key|apikey/i;

// Body keys that often hold secrets.
const SECRET_KEY =
  /^(password|passwd|pwd|pass|passcode|secret|clientsecret|token|accesstoken|refreshtoken|idtoken|apikey|authorization|auth|jwt|session|sessionid|sid|otp|pin|cvv|cvc|cardnumber|ssn)$/i;

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/[-_\s]/g, ''));
}

// Replaces the values of secret keys in a JSON or form body.
export function maskBody(
  text: string,
  mimeType: string | undefined,
  mask: (value: string) => string = () => MASK,
): string {
  const mime = mimeType ?? '';
  if (/json/i.test(mime) || /^\s*[[{]/.test(text)) {
    try {
      const walk = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(walk);
        if (value && typeof value === 'object') {
          return Object.fromEntries(
            Object.entries(value).map(([k, v]) => [
              k,
              isSecretKey(k) && (typeof v === 'string' || typeof v === 'number')
                ? mask(String(v))
                : walk(v),
            ]),
          );
        }
        return value;
      };
      return JSON.stringify(walk(JSON.parse(text)), null, 2);
    } catch {}
  }
  if (/x-www-form-urlencoded/i.test(mime)) {
    const params = new URLSearchParams(text);
    for (const [key, value] of [...params]) if (isSecretKey(key)) params.set(key, mask(value));
    return params.toString();
  }
  return text;
}

// Keeps recent requests from all tabs, with their headers and small text bodies.
export class NetworkBook {
  private entries: NetEntry[] = [];
  private byRequest = new WeakMap<HTTPRequest, NetEntry>();
  private seq = 0;
  private stepStart = 0;
  private bodyBytes = 0;

  get marker(): number {
    return this.seq;
  }

  attach(page: Page, tabId: string): void {
    page.on('request', (request: HTTPRequest) => this.onRequest(request, tabId));
    page.on('requestfinished', (request: HTTPRequest) => void this.onFinished(request));
    page.on('requestfailed', (request: HTTPRequest) => {
      const entry = this.byRequest.get(request);
      if (!entry) return;
      entry.endedAt = Date.now();
      entry.failure = request.failure()?.errorText ?? 'failed';
    });
  }

  private onRequest(request: HTTPRequest, tabId: string): void {
    this.seq += 1;
    const post = request.postData();
    const entry: NetEntry = {
      id: `r${this.seq}`,
      seq: this.seq,
      tabId,
      method: request.method(),
      url: request.url(),
      type: request.resourceType(),
      startedAt: Date.now(),
      requestHeaders: request.headers(),
      postData: post && post.length > MAX_POST ? `${post.slice(0, MAX_POST)}...` : post,
    };
    this.byRequest.set(request, entry);
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) {
      const dropped = this.entries.shift();
      if (dropped?.body) this.bodyBytes -= dropped.body.length;
    }
  }

  private async onFinished(request: HTTPRequest): Promise<void> {
    const entry = this.byRequest.get(request);
    const response = request.response();
    if (!entry || !response) return;
    entry.endedAt = Date.now();
    this.readResponse(entry, response);
    if (!BODY_TYPES.has(entry.type) || !TEXT_MIME.test(entry.mimeType ?? '')) {
      entry.bodyNote =
        'Walkthrough keeps bodies only for pages, XHR, and fetch requests with text.';
      return;
    }
    if (entry.status && entry.status >= 300 && entry.status < 400) return;
    try {
      const text = await response.text();
      entry.size ??= Buffer.byteLength(text);
      if (text.length > MAX_BODY) {
        entry.body = text.slice(0, MAX_BODY);
        entry.bodyNote = `The body has ${text.length} characters. Walkthrough kept the first ${MAX_BODY}.`;
      } else {
        entry.body = text;
      }
      this.bodyBytes += entry.body.length;
      this.trimBodies();
    } catch {
      entry.bodyNote = 'Chrome no longer had the body.';
    }
  }

  private readResponse(entry: NetEntry, response: HTTPResponse): void {
    const headers = response.headers();
    entry.status = response.status();
    entry.statusText = response.statusText();
    entry.responseHeaders = headers;
    entry.mimeType = (headers['content-type'] ?? '').split(';')[0]?.trim() || undefined;
    const length = Number(headers['content-length']);
    if (Number.isFinite(length) && length >= 0) entry.size = length;
    entry.fromCache = response.fromCache();
    entry.timing = response.timing() ?? undefined;
    const address = response.remoteAddress();
    if (address?.ip) entry.remoteAddress = address.ip;
  }

  // Drops the oldest bodies when they use too much memory.
  private trimBodies(): void {
    for (const entry of this.entries) {
      if (this.bodyBytes <= BODY_BUDGET) return;
      if (!entry.body) continue;
      this.bodyBytes -= entry.body.length;
      entry.body = undefined;
      entry.bodyNote = 'Walkthrough dropped this body to save memory.';
    }
  }

  get(id: string): NetEntry | undefined {
    return this.entries.find((e) => e.id === id);
  }

  since(marker: number): NetEntry[] {
    return this.entries.filter((e) => e.seq > marker);
  }

  currentStep(): NetEntry[] {
    return this.since(this.stepStart);
  }

  // Ends the current step: tags its requests and starts the next step.
  endStep(label: string): void {
    for (const entry of this.entries) {
      if (entry.seq > this.stepStart && !entry.step) entry.step = label;
    }
    this.stepStart = this.seq;
  }
}
