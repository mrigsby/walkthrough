import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

// The build puts the axe-core script here as text. Tests read it from node_modules.
declare const __UIWALK_AXE_SOURCE__: string | undefined;

export function axeSource(): string {
  if (typeof __UIWALK_AXE_SOURCE__ === 'string') return __UIWALK_AXE_SOURCE__;
  const require = createRequire(import.meta.url);
  return readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
}
