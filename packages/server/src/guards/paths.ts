import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToolError } from '../errors.js';
import { IMAGE_EXTENSIONS } from '../run/plan-schema.js';

const BLOCKED_NAMES = new Set(['config.local.yaml', 'config.local.yml']);

// Checks a file the agent wants to upload. Returns the full, real path.
export function checkUploadPath(file: string, uploadsRoot: string, projectDir: string): string {
  const full = isAbsolute(file) ? file : resolve(projectDir, file);
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new ToolError(`The file ${file} does not exist.`, 'upload_blocked');
  }
  if (!statSync(real).isFile()) {
    throw new ToolError(`${file} is not a file.`, 'upload_blocked');
  }

  const root = realpathSync(uploadsRoot);
  const rel = relative(root, real);
  if (rel.startsWith('..') || isAbsolute(rel)) {
    throw new ToolError(
      `Walkthrough can only upload files inside ${root}. ${file} is outside that folder.`,
      'upload_blocked',
    );
  }

  // No hidden files or folders (such as .env, .git, or .walkthrough).
  const parts = rel.split(sep);
  if (parts.some((part) => part.startsWith('.')) || BLOCKED_NAMES.has(basename(real))) {
    throw new ToolError(
      `Walkthrough does not upload hidden or private files, such as .env or saved logins. ${file} is blocked.`,
      'upload_blocked',
    );
  }
  return real;
}

// The real path of a file that may not exist yet: the real nearest folder, plus the rest.
function realTarget(full: string): string {
  if (existsSync(full)) return realpathSync(full);
  const missing: string[] = [];
  let dir = full;
  while (!existsSync(dir)) {
    missing.unshift(basename(dir));
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return join(realpathSync(dir), ...missing);
}

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
};

// Checks where the agent wants to save a screenshot. Returns the full, real path,
// and a short path to show: from the project folder when it is inside it.
export function checkScreenshotPath(
  file: string,
  projectDir: string,
  extraRoots: string[] = [],
): { path: string; display: string } {
  const full = isAbsolute(file) ? resolve(file) : resolve(projectDir, file);
  const ext = extname(full).toLowerCase();
  if (!(IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ToolError(
      `End the screenshot path with ${IMAGE_EXTENSIONS.join(', ')}. ${file} does not.`,
      'screenshot_blocked',
    );
  }
  const real = realTarget(full);
  if (existsSync(real) && !statSync(real).isFile()) {
    throw new ToolError(`${file} is a folder, not a file.`, 'screenshot_blocked');
  }

  const project = realTarget(projectDir);
  const roots = [project, ...extraRoots.map(realTarget)];
  const root = roots.find((r) => inside(r, real));
  if (!root) {
    const extra = extraRoots.length ? ` or in ${extraRoots.join(', ')}` : '';
    throw new ToolError(
      `Walkthrough saves screenshots only in the project folder${extra}. ${file} is outside. To allow another folder, add it to screenshotRoots in .walkthrough/config.local.yaml.`,
      'screenshot_blocked',
    );
  }

  // No hidden files or folders (such as .git or .walkthrough).
  if (
    relative(root, real)
      .split(sep)
      .some((part) => part.startsWith('.'))
  ) {
    throw new ToolError(
      `Walkthrough does not save screenshots in hidden files or folders, such as .git. ${file} is blocked.`,
      'screenshot_blocked',
    );
  }
  return { path: real, display: inside(project, real) ? relative(project, real) : real };
}
