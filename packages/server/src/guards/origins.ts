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

// A site that stays blocked, even when an allowed pattern matches it.
export interface DeniedOrigin {
  origin: string;
  // Why, for the message.
  reason: string;
}

export class OriginGuard {
  private readonly patterns: RegExp[];
  private readonly deniedPatterns: Array<{ re: RegExp; reason: string }>;

  constructor(
    readonly allowed: string[],
    readonly denied: DeniedOrigin[] = [],
  ) {
    this.patterns = allowed.map(patternToRegex);
    this.deniedPatterns = denied.map((d) => ({ re: patternToRegex(d.origin), reason: d.reason }));
  }

  private originOf(url: string): string | undefined {
    try {
      return new URL(url).origin;
    } catch {
      return undefined;
    }
  }

  private deniedReason(url: string): string | undefined {
    const origin = this.originOf(url);
    if (!origin) return undefined;
    return this.deniedPatterns.find((d) => d.re.test(origin))?.reason;
  }

  isAllowed(url: string): boolean {
    if (INTERNAL.test(url)) return true;
    const origin = this.originOf(url);
    if (!origin) return false;
    // Blocked sites win over allowed patterns, such as a wildcard.
    if (this.deniedPatterns.some((d) => d.re.test(origin))) return false;
    return this.patterns.some((re) => re.test(origin));
  }

  // Throws a helpful error when the URL is not allowed.
  check(url: string): void {
    if (this.isAllowed(url)) return;
    throw new ToolError(this.blockedMessage(url), 'origin_blocked');
  }

  blockedMessage(url: string): string {
    const reason = this.deniedReason(url);
    if (reason) return `Walkthrough blocked ${url}. ${reason}`;
    const origin = this.originOf(url) ?? url;
    return [
      `Walkthrough blocked ${url}. The site ${origin} is not in the allowed list.`,
      `Allowed sites: ${this.allowed.join(', ')}.`,
      'Ask the developer if this site is safe to test. To allow it, the developer adds it to "allowedOrigins" in .walkthrough/config.yaml.',
    ].join('\n');
  }
}
