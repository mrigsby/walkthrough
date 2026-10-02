import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import type { MockRule } from '../devtools/mock-schema.js';
import { ruleMatches } from '../devtools/mock-schema.js';
import type { EnvNetwork } from '../environments.js';
import { log } from '../log.js';

export interface RouterOptions {
  isAllowed: (url: string) => boolean;
  onBlocked: (url: string) => void;
  // The mock rules for this tab, in order. The first match wins.
  rules: () => MockRule[];
  onHit: (rule: MockRule, request: Protocol.Network.Request) => void;
  // Headers and a login for the site of the environment, if it has them.
  network?: () => EnvNetwork | undefined;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One CDP session for each tab that sees each request first.
// 1. The guard: a page load of a site that is not allowed gets an empty 204, so the tab stays.
// 2. Mock rules: answer, block, or delay a request.
// 3. Requests to the environment's site get its extra headers.
// 4. Everything else goes on as normal.
export class FetchRouter {
  private bypassingWorkers = false;

  private constructor(
    readonly cdp: CDPSession,
    private readonly mainFrameId: string,
    private readonly options: RouterOptions,
  ) {}

  static async install(page: Page, options: RouterOptions): Promise<FetchRouter | undefined> {
    try {
      const cdp = await page.createCDPSession();
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const router = new FetchRouter(cdp, frameTree.frame.id, options);
      cdp.on('Fetch.requestPaused', (event: Protocol.Fetch.RequestPausedEvent) => {
        router.onPaused(event).catch(() => undefined);
      });
      cdp.on('Fetch.authRequired', (event: Protocol.Fetch.AuthRequiredEvent) => {
        router.onAuth(event).catch(() => undefined);
      });
      await router.refresh();
      return router;
    } catch (error) {
      log.warn('could not turn on the request router for a tab', error);
      return undefined;
    }
  }

  // Page loads always pass through here, for the guard. Other requests only while mocks
  // exist, or when the environment's site needs headers or a login.
  async refresh(): Promise<void> {
    const patterns: Protocol.Fetch.RequestPattern[] = [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
    ];
    const network = this.options.network?.();
    if (this.options.rules().length > 0) {
      patterns.push({ urlPattern: '*', requestStage: 'Request' });
    } else if (network) {
      patterns.push({ urlPattern: `${network.origin}/*`, requestStage: 'Request' });
    }
    await this.cdp.send('Fetch.enable', {
      patterns,
      handleAuthRequests: Boolean(network?.credentials),
    });
    // Requests from a service worker skip this session, so they would miss the headers.
    const bypass = Boolean(network);
    if (bypass !== this.bypassingWorkers) {
      if (bypass) await this.cdp.send('Network.enable').catch(() => undefined);
      await this.cdp
        .send('Network.setBypassServiceWorker', { bypass })
        .catch((error) => log.warn('could not change the service worker setting', error));
      this.bypassingWorkers = bypass;
    }
  }

  // The request headers with the environment's headers added, for its own site only.
  private headersFor(request: Protocol.Network.Request): Protocol.Fetch.HeaderEntry[] | undefined {
    const network = this.options.network?.();
    if (!network || Object.keys(network.headers).length === 0) return undefined;
    let origin: string;
    try {
      origin = new URL(request.url).origin;
    } catch {
      return undefined;
    }
    if (origin !== network.origin) return undefined;
    // continueRequest replaces all headers, so keep the request's own.
    return Object.entries({ ...request.headers, ...network.headers }).map(([name, value]) => ({
      name,
      value: String(value),
    }));
  }

  // Basic auth: answer only for the environment's own site.
  private async onAuth(event: Protocol.Fetch.AuthRequiredEvent): Promise<void> {
    const network = this.options.network?.();
    let origin = '';
    try {
      origin = new URL(event.request.url).origin;
    } catch {}
    const login = network?.credentials;
    await this.cdp.send('Fetch.continueWithAuth', {
      requestId: event.requestId,
      authChallengeResponse:
        login && origin === network.origin
          ? { response: 'ProvideCredentials', username: login.username, password: login.password }
          : { response: 'Default' },
    });
  }

  private async onPaused(event: Protocol.Fetch.RequestPausedEvent): Promise<void> {
    const { requestId, request, frameId, resourceType } = event;
    const cdp = this.cdp;
    // Only guard the tab itself. Frames inside the page (like payment forms) may use other sites.
    if (
      resourceType === 'Document' &&
      frameId === this.mainFrameId &&
      !this.options.isAllowed(request.url)
    ) {
      this.options.onBlocked(request.url);
      await cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 204, body: '' });
      return;
    }
    const info = { url: request.url, method: request.method, type: resourceType };
    const rule = this.options
      .rules()
      .find((r) => (r.times === undefined || r.hits < r.times) && ruleMatches(r, info));
    const headers = this.headersFor(request);
    if (!rule) {
      await cdp.send('Fetch.continueRequest', { requestId, ...(headers ? { headers } : {}) });
      return;
    }
    rule.hits += 1;
    this.options.onHit(rule, request);
    if (rule.delayMs) await wait(rule.delayMs);
    if (rule.block) {
      await cdp.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' });
      return;
    }
    const answers =
      rule.status !== undefined ||
      rule.json !== undefined ||
      rule.body !== undefined ||
      rule.headers !== undefined;
    if (!answers) {
      await cdp.send('Fetch.continueRequest', { requestId, ...(headers ? { headers } : {}) });
      return;
    }
    const body = rule.json !== undefined ? JSON.stringify(rule.json) : (rule.body ?? '');
    const contentType =
      rule.contentType ??
      (rule.json !== undefined ? 'application/json' : 'text/plain; charset=utf-8');
    const responseHeaders = Object.entries({ 'content-type': contentType, ...rule.headers }).map(
      ([name, value]) => ({ name, value }),
    );
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: rule.status ?? 200,
      responseHeaders,
      body: Buffer.from(body).toString('base64'),
    });
  }
}
