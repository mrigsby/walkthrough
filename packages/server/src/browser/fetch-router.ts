import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import type { MockRule } from '../devtools/mock-schema.js';
import { ruleMatches } from '../devtools/mock-schema.js';
import { log } from '../log.js';

export interface RouterOptions {
  isAllowed: (url: string) => boolean;
  onBlocked: (url: string) => void;
  // The mock rules for this tab, in order. The first match wins.
  rules: () => MockRule[];
  onHit: (rule: MockRule, request: Protocol.Network.Request) => void;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// One CDP session for each tab that sees each request first.
// 1. The guard: a page load of a site that is not allowed gets an empty 204, so the tab stays.
// 2. Mock rules: answer, block, or delay a request.
// 3. Everything else goes on as normal.
export class FetchRouter {
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
      await router.refresh();
      return router;
    } catch (error) {
      log.warn('could not turn on the request router for a tab', error);
      return undefined;
    }
  }

  // Page loads always pass through here, for the guard. Other requests only while mocks exist.
  async refresh(): Promise<void> {
    const patterns: Protocol.Fetch.RequestPattern[] = [
      { urlPattern: '*', resourceType: 'Document', requestStage: 'Request' },
    ];
    if (this.options.rules().length > 0)
      patterns.push({ urlPattern: '*', requestStage: 'Request' });
    await this.cdp.send('Fetch.enable', { patterns });
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
    if (!rule) {
      await cdp.send('Fetch.continueRequest', { requestId });
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
      await cdp.send('Fetch.continueRequest', { requestId });
      return;
    }
    const body = rule.json !== undefined ? JSON.stringify(rule.json) : (rule.body ?? '');
    const contentType =
      rule.contentType ??
      (rule.json !== undefined ? 'application/json' : 'text/plain; charset=utf-8');
    const headers = Object.entries({ 'content-type': contentType, ...rule.headers }).map(
      ([name, value]) => ({ name, value }),
    );
    await cdp.send('Fetch.fulfillRequest', {
      requestId,
      responseCode: rule.status ?? 200,
      responseHeaders: headers,
      body: Buffer.from(body).toString('base64'),
    });
  }
}
