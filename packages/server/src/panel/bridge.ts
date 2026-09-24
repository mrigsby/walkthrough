import { randomBytes } from 'node:crypto';
import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import { log } from '../log.js';
import { pageCandidates } from '../page/selectors.js';
import { PANEL_CSS } from './panel-css.js';
import { panelMain } from './panel-script.js';

// A random world and binding name for each server, so a page cannot guess them.
const TOKEN = randomBytes(6).toString('hex');
export const WORLD_NAME = `uiwalk-${TOKEN}`;
const BINDING = `__uiwalk_${TOKEN}`;

// The selector helper goes in too, so the recorder picks targets like the rest of Walkthrough.
const SOURCE = `(${panelMain.toString()})(${JSON.stringify({ binding: BINDING, css: PANEL_CSS })}, ${pageCandidates.toString()});`;

export type PanelMessage = Record<string, unknown> & { type: string };

// Connects the server to the panel in one tab.
export class PanelBridge {
  private contextId?: number;

  private constructor(
    private readonly cdp: CDPSession,
    private readonly onMessage: (msg: PanelMessage) => void,
  ) {}

  static async install(
    page: Page,
    onMessage: (msg: PanelMessage) => void,
  ): Promise<PanelBridge | undefined> {
    try {
      const cdp = await page.createCDPSession();
      const bridge = new PanelBridge(cdp, onMessage);
      cdp.on('Runtime.bindingCalled', (event: Protocol.Runtime.BindingCalledEvent) =>
        bridge.onBinding(event),
      );
      await cdp.send('Runtime.enable');
      // The binding only exists in our isolated world. Page scripts cannot call it.
      await cdp.send('Runtime.addBinding', { name: BINDING, executionContextName: WORLD_NAME });
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: SOURCE,
        worldName: WORLD_NAME,
      });

      // Also add the panel to the page that is open now.
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: WORLD_NAME,
      });
      await cdp.send('Runtime.evaluate', { expression: SOURCE, contextId: executionContextId });
      return bridge;
    } catch (error) {
      log.warn('could not add the panel to a tab', error);
      return undefined;
    }
  }

  private onBinding(event: Protocol.Runtime.BindingCalledEvent): void {
    if (event.name !== BINDING) return;
    let msg: PanelMessage;
    try {
      msg = JSON.parse(event.payload) as PanelMessage;
    } catch {
      return;
    }
    // Remember where the panel lives now. It changes after each page load.
    this.contextId = event.executionContextId;
    this.onMessage(msg);
  }

  get ready(): boolean {
    return this.contextId !== undefined;
  }

  // Sends a message to the panel. Returns false if the panel is not ready.
  async send(msg: PanelMessage): Promise<boolean> {
    if (this.contextId === undefined) return false;
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.__uiwalkPanel && window.__uiwalkPanel.receive(${JSON.stringify(msg)})`,
        contextId: this.contextId,
      });
      return true;
    } catch {
      // The page changed. The new panel will say hello soon.
      return false;
    }
  }
}
