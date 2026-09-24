import { ToolError } from '../errors.js';

// Default sites the agent may open: this computer only.
export const DEFAULT_ORIGINS = ['http://localhost:*', 'http://127.0.0.1:*', 'https://localhost:*'];

// Pages the browser uses by itself. Always allowed.
const INTERNAL = /^(about:blank|about:srcdoc|chrome-error:\/\/|data:text\/html,uiwalk)/;

function escapeRegex(text: string): string {
  return text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
}

// Turns "https://*.example.com:*" into a regex. "*" matches any part.
function patternToRegex(pattern: string): RegExp {
  const trimmed = pattern.trim().replace(/\/+$/, '');
  const match = /^(https?):\/\/([^/:]+)(?::(\d+|\*))?$/.exec(trimmed);
  if (!match) {
    throw new ToolError(
      `The allowed origin "${pattern}" is not valid. Use a form like "http://localhost:3000" or "https://*.example.com".`,
    );
  }
  const [, scheme, host = '', port] = match;
  const hostRe = escapeRegex(host).replace(/\\\*|\*/g, '[^.]+');
  let portRe = '';
  if (port === '*') portRe = '(?::\\d+)?';
  else if (port) portRe = `:${port}`;
  return new RegExp(`^${scheme}://${hostRe}${portRe}$`, 'i');
}

export class OriginGuard {
  private readonly patterns: RegExp[];

  constructor(readonly allowed: string[]) {
    this.patterns = allowed.map(patternToRegex);
  }

  isAllowed(url: string): boolean {
    if (INTERNAL.test(url)) return true;
    let origin: string;
    try {
      origin = new URL(url).origin;
    } catch {
      return false;
    }
    return this.patterns.some((re) => re.test(origin));
  }

  // Throws a helpful error when the URL is not allowed.
  check(url: string): void {
    if (this.isAllowed(url)) return;
    throw new ToolError(this.blockedMessage(url), 'origin_blocked');
  }

  blockedMessage(url: string): string {
    let origin = url;
    try {
      origin = new URL(url).origin;
    } catch {}
    return [
      `Walkthrough blocked ${url}. The site ${origin} is not in the allowed list.`,
      `Allowed sites: ${this.allowed.join(', ')}.`,
      'Ask the developer if this site is safe to test. To allow it, the developer adds it to "allowedOrigins" in .walkthrough/config.yaml.',
    ].join('\n');
  }
}
