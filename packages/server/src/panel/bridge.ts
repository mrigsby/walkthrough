import { randomBytes } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { type BridgeMessage, IsolatedBridge } from '../browser/isolated-bridge.js';
import { pageCandidates } from '../page/selectors.js';
import { PANEL_CSS } from './panel-css.js';
import { panelMain } from './panel-script.js';

// A random world and binding name for each server, so a page cannot guess them.
const TOKEN = randomBytes(6).toString('hex');
export const WORLD_NAME = `uiwalk-${TOKEN}`;
const BINDING = `__uiwalk_${TOKEN}`;

// The selector helper goes in too, so the recorder picks targets like the rest of Walkthrough.
const SOURCE = `(${panelMain.toString()})(${JSON.stringify({ binding: BINDING, css: PANEL_CSS })}, ${pageCandidates.toString()});`;

export type PanelMessage = BridgeMessage;

// Connects the server to the panel in one tab.
export class PanelBridge {
  private constructor(private readonly bridge: IsolatedBridge) {}

  static async install(
    page: Page,
    onMessage: (msg: PanelMessage) => void,
  ): Promise<PanelBridge | undefined> {
    const bridge = await IsolatedBridge.install(
      page,
      { world: WORLD_NAME, binding: BINDING, source: SOURCE, receiver: '__uiwalkPanel' },
      onMessage,
    );
    return bridge ? new PanelBridge(bridge) : undefined;
  }

  // Starts or stops hiding the panel on each new page in this tab, before its first paint.
  async hideOnLoad(on: boolean): Promise<void> {
    await this.bridge.setOnLoad('hide', on ? { type: 'hide', hidden: true } : undefined);
  }

  get ready(): boolean {
    return this.bridge.ready;
  }

  // Sends a message to the panel. Returns false if the panel is not ready.
  send(msg: PanelMessage): Promise<boolean> {
    return this.bridge.send(msg);
  }
}
