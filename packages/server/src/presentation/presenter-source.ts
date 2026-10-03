import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The build puts the presenter page script here as text. Running from source builds it now.
declare const __UIWALK_PRESENTER_SOURCE__: string | undefined;

let built: string | undefined;

export async function presenterSource(): Promise<string> {
  if (typeof __UIWALK_PRESENTER_SOURCE__ === 'string') return __UIWALK_PRESENTER_SOURCE__;
  if (built) return built;
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'presenter-page', 'main.ts')],
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome120',
    minify: true,
    write: false,
    legalComments: 'none',
  });
  built = result.outputFiles[0]?.text ?? '';
  return built;
}
