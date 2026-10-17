import { randomBytes } from 'node:crypto';
import type { Page } from 'puppeteer-core';
import { type BridgeMessage, IsolatedBridge } from '../browser/isolated-bridge.js';
import type { Rect } from '../panel/controller.js';
import { maskMain } from './mask-script.js';

// What a video blurs: secret values in the page, and elements that match the selectors.
export interface MaskConfig {
  secrets: string[];
  selectors: string[];
}

export function hasMask(config?: MaskConfig): config is MaskConfig {
  return Boolean(config && (config.secrets.length || config.selectors.length));
}

const TOKEN = randomBytes(6).toString('hex');
const WORLD = `uiwalk-mask-${TOKEN}`;
const BINDING = `__uiwalk_mask_${TOKEN}`;
const SOURCE = `(${maskMain.toString()})(${JSON.stringify({ binding: BINDING })});`;

type Listener = (boxes: Rect[]) => void;

// The mask script of one tab. Every recording of the tab shares it.
export class VideoMasker {
  private static readonly byPage = new WeakMap<Page, Promise<VideoMasker | undefined>>();
  private readonly listeners = new Set<Listener>();
  private config: MaskConfig = { secrets: [], selectors: [] };

  private constructor(private readonly bridge: IsolatedBridge) {}

  static for(page: Page): Promise<VideoMasker | undefined> {
    let found = VideoMasker.byPage.get(page);
    if (!found) {
      found = (async () => {
        let masker: VideoMasker | undefined;
        const bridge = await IsolatedBridge.install(
          page,
          { world: WORLD, binding: BINDING, source: SOURCE, receiver: '__uiwalkMask' },
          (msg) => masker?.onMessage(msg),
        );
        masker = bridge ? new VideoMasker(bridge) : undefined;
        return masker;
      })();
      VideoMasker.byPage.set(page, found);
    }
    return found;
  }

  private onMessage(msg: BridgeMessage): void {
    // A new page started. It has the settings already, from the load script.
    if (msg.type === 'hello') {
      void this.bridge.send({ type: 'config', ...this.config });
      return;
    }
    if (msg.type !== 'boxes' || !Array.isArray(msg.boxes)) return;
    const boxes = (msg.boxes as Rect[])
      .filter((b) => [b.x, b.y, b.width, b.height].every((n) => typeof n === 'number'))
      .slice(0, 200);
    for (const listener of this.listeners) listener(boxes);
  }

  // A recording listens to the boxes. When the last one stops, the page forgets the secrets.
  async subscribe(
    config: MaskConfig,
    listener: Listener,
  ): Promise<{ update: (config: MaskConfig) => Promise<void>; stop: () => Promise<void> }> {
    this.listeners.add(listener);
    await this.setConfig(config);
    return {
      update: (next) => this.setConfig(next),
      stop: async () => {
        this.listeners.delete(listener);
        if (this.listeners.size === 0) await this.setConfig({ secrets: [], selectors: [] });
      },
    };
  }

  private async setConfig(config: MaskConfig): Promise<void> {
    this.config = config;
    const msg = { type: 'config', ...config };
    // New pages get it before their first paint.
    await this.bridge.setOnLoad('config', hasMask(config) ? msg : undefined);
    await this.bridge.send(msg);
  }
}
