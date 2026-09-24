// Bundles the server into one file inside the plugin.
// Usage: node scripts/build-plugin.mjs [--watch]
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const outFile = join(root, 'plugins/walkthrough/server/uiwalk.mjs');
const pkg = JSON.parse(await readFile(join(root, 'packages/server/package.json'), 'utf8'));
const watch = process.argv.includes('--watch');

// Some dependencies use require(). This lets them work in an ES module file.
const banner = [
  '#!/usr/bin/env node',
  "import { createRequire as __uiwalkCreateRequire } from 'node:module';",
  'const require = __uiwalkCreateRequire(import.meta.url);',
].join('\n');

/** @type {esbuild.BuildOptions} */
const options = {
  entryPoints: [join(root, 'packages/server/src/index.ts')],
  outfile: outFile,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: { js: banner },
  define: {
    __UIWALK_VERSION__: JSON.stringify(pkg.version),
    // The accessibility checker runs inside pages, so it goes in as text.
    __UIWALK_AXE_SOURCE__: JSON.stringify(
      await readFile(join(root, 'node_modules/axe-core/axe.min.js'), 'utf8'),
    ),
  },
  // Optional speed-ups for ws, and the BiDi protocol we do not use.
  external: ['bufferutil', 'utf-8-validate', 'chromium-bidi', 'chromium-bidi/*'],
  legalComments: 'none',
  metafile: true,
  logLevel: 'warning',
};

// Writes license notices for the code packed into the bundle.
async function writeLicenses(metafile) {
  // axe-core goes in as text, so esbuild does not list it. Add it here.
  const packages = new Map([['axe-core', 'node_modules/axe-core']]);
  for (const input of Object.keys(metafile.inputs)) {
    const match = input.match(/node_modules\/((?:@[^/]+\/)?[^/]+)\//);
    if (match?.[1])
      packages.set(match[1], input.slice(0, input.indexOf(match[1]) + match[1].length));
  }
  const sections = [];
  for (const [name, dir] of [...packages].sort(([a], [b]) => a.localeCompare(b))) {
    const info = JSON.parse(await readFile(join(root, dir, 'package.json'), 'utf8'));
    let text = '';
    // Some packages spell the file name the British way. check-text-ignore-next-line
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE']) {
      try {
        text = await readFile(join(root, dir, file), 'utf8');
        break;
      } catch {}
    }
    sections.push(
      `${name} ${info.version} (${info.license ?? 'unknown'})\n\n${text.trim() || 'No license file found in the package.'}`,
    );
  }
  const header = 'Third-party software packed into uiwalk.mjs, with license notices.';
  await writeFile(
    join(dirname(outFile), 'THIRD_PARTY_LICENSES.txt'),
    `${header}\n\n${sections.join(`\n\n${'='.repeat(72)}\n\n`)}\n`,
  );
}

await mkdir(dirname(outFile), { recursive: true });

// The skill gets its own copy of the plan format guide, because a plugin
// install copies only the plugin folder.
const guide = await readFile(join(root, 'docs/plan-format.md'), 'utf8');
await writeFile(
  join(root, 'plugins/walkthrough/skills/walkthrough/references/plan-format.md'),
  `<!-- Copied from docs/plan-format.md by scripts/build-plugin.mjs. Edit that file. -->\n\n${guide}`,
);

if (watch) {
  const ctx = await esbuild.context({
    ...options,
    plugins: [
      {
        name: 'licenses',
        setup(build) {
          build.onEnd(async (result) => {
            if (result.metafile) await writeLicenses(result.metafile);
            console.log(`[build-plugin] rebuilt ${new Date().toLocaleTimeString()}`);
          });
        },
      },
    ],
  });
  await ctx.watch();
  console.log('[build-plugin] watching for changes');
} else {
  const result = await esbuild.build(options);
  await writeLicenses(result.metafile);
  console.log(`[build-plugin] wrote ${outFile}`);
}
