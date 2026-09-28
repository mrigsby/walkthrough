import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// The build puts the encoder page script here as text. Running from source builds it now.
declare const __UIWALK_ENCODER_SOURCE__: string | undefined;

let built: string | undefined;

export async function encoderSource(): Promise<string> {
  if (typeof __UIWALK_ENCODER_SOURCE__ === 'string') return __UIWALK_ENCODER_SOURCE__;
  if (built) return built;
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    entryPoints: [join(dirname(fileURLToPath(import.meta.url)), 'encoder-page', 'main.ts')],
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
