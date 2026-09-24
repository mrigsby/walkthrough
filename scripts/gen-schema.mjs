// Writes the JSON Schema for test plans, for editor autocomplete.
// Run it after "npm run build:plugin".
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const schema = execFileSync(
  process.execPath,
  [join(root, 'plugins/walkthrough/server/uiwalk.mjs'), 'schema'],
  {
    encoding: 'utf8',
  },
);

// The main copy, plus the copy the demo project uses.
for (const file of [
  'schemas/plan.schema.json',
  'examples/demo-app/.walkthrough/plan.schema.json',
]) {
  mkdirSync(dirname(join(root, file)), { recursive: true });
  writeFileSync(join(root, file), schema);
  console.log(`[gen-schema] wrote ${file}`);
}
