import type { Config } from '../config.js';
import { rebaseUrl } from '../environments.js';
import type { Run } from '../run/run-store.js';

// Moves the addresses of a recorded run to another environment, such as a staging run
// replayed on production. Addresses on other sites stay as they are.
export class Rebaser {
  // Base URLs to move from, longest first, so the most exact one wins.
  private readonly from: string[];

  constructor(
    from: Array<string | undefined>,
    readonly to?: string,
  ) {
    this.from = [...new Set(from.filter((u): u is string => Boolean(u)))].sort(
      (a, b) => b.length - a.length,
    );
  }

  // From the run's environment, and any environment in the settings, to the one in use.
  static forRun(run: Pick<Run, 'baseUrl' | 'environment'>, config: Config): Rebaser {
    return new Rebaser(
      [
        run.environment?.baseUrl,
        run.baseUrl,
        ...Object.values(config.environments).map((e) => e.baseUrl),
      ],
      config.environment.baseUrl,
    );
  }

  url(url: string): string {
    for (const base of this.from) {
      const moved = rebaseUrl(url, base, this.to);
      if (moved) return moved;
    }
    return url;
  }

  // A cookie domain on the old site moves to the new site.
  host(host: string): string {
    if (!this.to) return host;
    const bare = host.replace(/^\./, '');
    for (const base of this.from) {
      try {
        if (new URL(base).hostname === bare) {
          const to = new URL(this.to).hostname;
          return host.startsWith('.') ? `.${to}` : to;
        }
      } catch {}
    }
    return host;
  }

  // A mock URL pattern on the old site, like "https://staging.example.com/api/*".
  pattern(pattern: string): string {
    return /^https?:\/\//.test(pattern) ? this.url(pattern) : pattern;
  }
}
