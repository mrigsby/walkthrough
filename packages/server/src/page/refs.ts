import type { ElementHandle, SerializedAXNode } from 'puppeteer-core';
import { ToolError } from '../errors.js';

interface RefEntry {
  node: SerializedAXNode;
  tabId: string;
  nav: number;
}

export interface ResolvedRef {
  handle: ElementHandle<Element>;
  role: string;
  name: string;
}

// Short names like "e12" for elements in the last snapshot.
export class RefTable {
  private entries = new Map<string, RefEntry>();
  private handles: ElementHandle[] = [];
  private counter = 0;

  // Starts a new snapshot. Old refs stop working.
  // Numbers keep going up, so an old ref can never point at a new element.
  async reset(): Promise<void> {
    this.entries.clear();
    const old = this.handles;
    this.handles = [];
    await Promise.all(old.map((h) => h.dispose().catch(() => undefined)));
  }

  add(node: SerializedAXNode, tabId: string, nav: number): string {
    this.counter += 1;
    const ref = `e${this.counter}`;
    this.entries.set(ref, { node, tabId, nav });
    return ref;
  }

  // Gets the element for a ref. Fails if the page changed since the snapshot.
  async resolve(ref: string, tabId: string, nav: number): Promise<ResolvedRef> {
    const entry = this.entries.get(ref);
    const retake = 'Take a new snapshot and use a ref from it.';
    if (!entry) throw new ToolError(`There is no ref "${ref}". ${retake}`, 'stale_ref');
    if (entry.tabId !== tabId) {
      throw new ToolError(`Ref "${ref}" is from another tab. ${retake}`, 'stale_ref');
    }
    if (entry.nav !== nav) {
      throw new ToolError(
        `The page changed after the snapshot, so ref "${ref}" is old. ${retake}`,
        'stale_ref',
      );
    }
    const handle = (await entry.node
      .elementHandle()
      .catch(() => null)) as ElementHandle<Element> | null;
    if (!handle)
      throw new ToolError(`The element for ref "${ref}" is gone. ${retake}`, 'stale_ref');
    this.handles.push(handle);
    const connected = await handle.evaluate((el) => el.isConnected).catch(() => false);
    if (!connected) {
      throw new ToolError(
        `The element for ref "${ref}" was removed from the page. ${retake}`,
        'stale_ref',
      );
    }
    return { handle, role: entry.node.role, name: entry.node.name ?? '' };
  }
}
