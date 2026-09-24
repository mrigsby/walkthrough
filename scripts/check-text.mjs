// Fails if our own text has an em dash or a British spelling.
// Add "check-text-ignore" to a line to skip it,
// or "check-text-ignore-next-line" to skip the line below.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const self = fileURLToPath(import.meta.url);

const EM_DASH = '\u2014';

// Folders to scan, from the repo root.
const scanDirs = [
  '.claude-plugin',
  '.github',
  'docs',
  'examples',
  'packages',
  'plugins',
  'scripts',
];

// Paths to skip: generated, third party, or not ours.
const skip = [
  /(^|\/)node_modules\//,
  /(^|\/)dist\//,
  /(^|\/)coverage\//,
  /^plugins\/walkthrough\/server\//,
  /(^|\/)package-lock\.json$/,
  /(^|\/)\.walkthrough\/runs\//,
];

const extensions = new Set([
  '.ts',
  '.mts',
  '.js',
  '.mjs',
  '.cjs',
  '.json',
  '.md',
  '.yaml',
  '.yml',
  '.html',
  '.css',
  '.txt',
]);

// Common British spellings and their American form.
const words = {
  colour: 'color',
  colours: 'colors',
  coloured: 'colored',
  behaviour: 'behavior',
  behaviours: 'behaviors',
  favour: 'favor',
  favourite: 'favorite',
  honour: 'honor',
  labour: 'labor',
  neighbour: 'neighbor',
  flavour: 'flavor',
  humour: 'humor',
  rumour: 'rumor',
  centre: 'center',
  centres: 'centers',
  centred: 'centered',
  metre: 'meter',
  metres: 'meters',
  litre: 'liter',
  theatre: 'theater',
  fibre: 'fiber',
  licence: 'license',
  licences: 'licenses',
  defence: 'defense',
  offence: 'offense',
  catalogue: 'catalog',
  programme: 'program',
  programmes: 'programs',
  grey: 'gray',
  whilst: 'while',
  amongst: 'among',
  artefact: 'artifact',
  artefacts: 'artifacts',
  judgement: 'judgment',
  fulfil: 'fulfill',
  enrol: 'enroll',
  cheque: 'check',
  tyre: 'tire',
  aluminium: 'aluminum',
  cancelled: 'canceled',
  cancelling: 'canceling',
  travelled: 'traveled',
  travelling: 'traveling',
  modelled: 'modeled',
  modelling: 'modeling',
  labelled: 'labeled',
  labelling: 'labeling',
  signalled: 'signaled',
  signalling: 'signaling',
  levelled: 'leveled',
  fuelled: 'fueled',
  analyse: 'analyze',
  analysed: 'analyzed',
  analysing: 'analyzing',
};

// "-ise" verbs that are "-ize" in American English.
const iseStems = [
  'organ',
  'initial',
  'custom',
  'recogn',
  'real',
  'optim',
  'normal',
  'serial',
  'sanit',
  'author',
  'util',
  'priorit',
  'summar',
  'minim',
  'maxim',
  'visual',
  'synchron',
  'standard',
  'apolog',
  'final',
  'categor',
  'memor',
  'local',
  'special',
  'capital',
  'emphas',
  'personal',
  'central',
  'modern',
  'stabil',
  'token',
  'container',
  'parameter',
  'character',
  'critic',
];

const wordPattern = new RegExp(`\\b(${Object.keys(words).join('|')})\\b`, 'gi');
const isePattern = new RegExp(
  `\\b(${iseStems.join('|')})(is)(e|es|ed|ing|ation|ations|er|ers)\\b`,
  'gi',
);

async function* walk(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    const rel = relative(root, full).split('\\').join('/');
    if (skip.some((re) => re.test(rel + (entry.isDirectory() ? '/' : '')))) continue;
    if (entry.isDirectory()) yield* walk(full);
    else if (extensions.has(extname(entry.name)) || entry.name === '.env.example') yield full;
  }
}

async function rootFiles() {
  const entries = await readdir(root, { withFileTypes: true });
  return entries
    .filter((e) => e.isFile() && ['.md', '.json'].includes(extname(e.name)))
    .filter((e) => e.name !== 'package-lock.json')
    .map((e) => join(root, e.name));
}

const problems = [];

async function check(file) {
  if (file === self) return;
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');
  lines.forEach((line, index) => {
    if (line.includes('check-text-ignore')) return;
    if (lines[index - 1]?.includes('check-text-ignore-next-line')) return;
    const where = `${relative(root, file)}:${index + 1}`;
    if (line.includes(EM_DASH))
      problems.push(`${where}  em dash found. Use a comma, colon, or period.`);
    for (const match of line.matchAll(wordPattern)) {
      const american = words[match[1].toLowerCase()];
      problems.push(`${where}  "${match[1]}" is British. Use "${american}".`);
    }
    for (const match of line.matchAll(isePattern)) {
      problems.push(`${where}  "${match[0]}" is British. Use "${match[1]}iz${match[3]}".`);
    }
  });
}

const files = [...(await rootFiles())];
for (const dir of scanDirs) {
  for await (const file of walk(join(root, dir))) files.push(file);
}
await Promise.all(files.map(check));

if (problems.length > 0) {
  console.error(`check-text found ${problems.length} problem(s):\n`);
  for (const problem of problems.sort()) console.error(`  ${problem}`);
  process.exit(1);
}
console.log(`check-text: ${files.length} files OK`);
