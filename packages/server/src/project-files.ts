import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const GITIGNORE = `# Created by Walkthrough. These files stay on this computer.
.env
sessions/
runs/
config.local.yaml
`;

// Makes the .walkthrough folder and its .gitignore, if they are missing.
export function ensureWalkthroughDir(projectDir: string): string {
  const dir = join(projectDir, '.walkthrough');
  mkdirSync(dir, { recursive: true });
  const ignore = join(dir, '.gitignore');
  if (!existsSync(ignore)) writeFileSync(ignore, GITIGNORE);
  return dir;
}

function stamp(date = new Date()): { day: string; time: string } {
  const pad = (n: number) => String(n).padStart(2, '0');
  return {
    day: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`,
  };
}

// Folder for screenshots taken outside a test run.
export function adhocEvidenceDir(projectDir: string): string {
  const dir = join(ensureWalkthroughDir(projectDir), 'runs', `adhoc-${stamp().day}`, 'screenshots');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function fileStamp(label?: string): string {
  const safe = (label ?? 'screenshot')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
  return `${stamp().time}-${safe || 'screenshot'}`;
}
