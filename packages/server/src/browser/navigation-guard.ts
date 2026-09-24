import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import { log } from '../log.js';

// Stops the tab from leaving the allowed sites, even by a click.
// A blocked page load gets an empty "204" answer, so the tab stays where it is.
export async function guardNavigation(
  page: Page,
  isAllowed: (url: string) => boolean,
  onBlocked: (url: string) => void,
): Promise<CDPSession | undefined> {
  try {
    const cdp = await page.createCDPSession();
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const mainFrameId = frameTree.frame.id;

    cdp.on('Fetch.requestPaused', (event: Protocol.Fetch.RequestPausedEvent) => {
      const { requestId, request, frameId } = event;
      // Only guard the tab itself. Frames inside the page (like payment forms) may use other sites.
      const blocked = frameId === mainFrameId && !isAllowed(request.url);
      const reply = blocked
        ? cdp.send('Fetch.fulfillRequest', { requestId, responseCode: 204, body: '' })
        : cdp.send('Fetch.continueRequest', { requestId });
      if (blocked) onBlocked(request.url);
      reply.catch(() => undefined);
    });

    await cdp.send('Fetch.enable', {
      patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
    });
    return cdp;
  } catch (error) {
    log.warn('could not turn on the navigation guard for a tab', error);
    return undefined;
  }
}
