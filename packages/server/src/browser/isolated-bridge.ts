import type { CDPSession, Page, Protocol } from 'puppeteer-core';
import { log } from '../log.js';

export type BridgeMessage = Record<string, unknown> & { type: string };

// A script that Walkthrough puts into each page of a tab, in a world of its own.
export interface IsolatedScript {
  // A random world name. Page scripts cannot see this world.
  world: string;
  // A random binding name, only in that world. The script sends messages with it.
  binding: string;
  // The script. It sets window[receiver] = { receive(msg) }.
  source: string;
  receiver: string;
}

// Connects the server to a script in an isolated world of one tab, like the panel.
export class IsolatedBridge {
  private contextId?: number;
  private readonly onLoad = new Map<string, string>();

  private constructor(
    private readonly cdp: CDPSession,
    private readonly script: IsolatedScript,
    private readonly onMessage: (msg: BridgeMessage) => void,
  ) {}

  static async install(
    page: Page,
    script: IsolatedScript,
    onMessage: (msg: BridgeMessage) => void,
  ): Promise<IsolatedBridge | undefined> {
    try {
      const cdp = await page.createCDPSession();
      const bridge = new IsolatedBridge(cdp, script, onMessage);
      cdp.on('Runtime.bindingCalled', (event: Protocol.Runtime.BindingCalledEvent) =>
        bridge.onBinding(event),
      );
      await cdp.send('Runtime.enable');
      // The binding only exists in our isolated world. Page scripts cannot call it.
      await cdp.send('Runtime.addBinding', {
        name: script.binding,
        executionContextName: script.world,
      });
      await cdp.send('Page.enable');
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: script.source,
        worldName: script.world,
      });

      // Also add the script to the page that is open now.
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
        frameId: frameTree.frame.id,
        worldName: script.world,
      });
      await cdp.send('Runtime.evaluate', {
        expression: script.source,
        contextId: executionContextId,
      });
      return bridge;
    } catch (error) {
      log.warn('could not add a script to a tab', error);
      return undefined;
    }
  }

  private onBinding(event: Protocol.Runtime.BindingCalledEvent): void {
    if (event.name !== this.script.binding) return;
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(event.payload) as BridgeMessage;
    } catch {
      return;
    }
    // Remember where the script lives now. It changes after each page load.
    this.contextId = event.executionContextId;
    this.onMessage(msg);
  }

  // Runs a message for the script at the start of each new page, before its first paint.
  // It runs after the script itself. Undefined removes it.
  async setOnLoad(key: string, msg: BridgeMessage | undefined): Promise<void> {
    try {
      const old = this.onLoad.get(key);
      if (old) {
        this.onLoad.delete(key);
        await this.cdp.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: old });
      }
      if (!msg) return;
      const { receiver } = this.script;
      const { identifier } = await this.cdp.send('Page.addScriptToEvaluateOnNewDocument', {
        source: `window.${receiver} && window.${receiver}.receive(${JSON.stringify(msg)});`,
        worldName: this.script.world,
      });
      this.onLoad.set(key, identifier);
    } catch {
      // The tab closed.
    }
  }

  get ready(): boolean {
    return this.contextId !== undefined;
  }

  // Sends a message to the script. Returns false if it is not ready.
  async send(msg: BridgeMessage): Promise<boolean> {
    if (this.contextId === undefined) return false;
    const { receiver } = this.script;
    try {
      await this.cdp.send('Runtime.evaluate', {
        expression: `window.${receiver} && window.${receiver}.receive(${JSON.stringify(msg)})`,
        contextId: this.contextId,
      });
      return true;
    } catch {
      // The page changed. The new script will say hello soon.
      return false;
    }
  }
}
