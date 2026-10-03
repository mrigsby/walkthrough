import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { ToolError } from '../errors.js';
import { IMAGE_EXTENSIONS, SLIDE_IMAGE_EXTENSIONS } from '../run/plan-schema.js';
import { VIDEO_EXTENSIONS } from '../video/formats.js';

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

// What kind of file an output path is for.
interface OutputKind {
  // "screenshot" or "video", in messages.
  noun: string;
  extensions: readonly string[];
  code: string;
}

const SCREENSHOT: OutputKind = {
  noun: 'screenshot',
  extensions: IMAGE_EXTENSIONS,
  code: 'screenshot_blocked',
};
const VIDEO: OutputKind = { noun: 'video', extensions: VIDEO_EXTENSIONS, code: 'video_blocked' };

// Checks where the agent wants to save a file. Returns the full, real path,
// and a short path to show: from the project folder when it is inside it.
function checkOutputPath(
  file: string,
  projectDir: string,
  extraRoots: string[],
  kind: OutputKind,
): { path: string; display: string } {
  const full = isAbsolute(file) ? resolve(file) : resolve(projectDir, file);
  const ext = extname(full).toLowerCase();
  if (!kind.extensions.includes(ext)) {
    throw new ToolError(
      `End the ${kind.noun} path with ${kind.extensions.join(', ')}. ${file} does not.`,
      kind.code,
    );
  }
  const real = realTarget(full);
  if (existsSync(real) && !statSync(real).isFile()) {
    throw new ToolError(`${file} is a folder, not a file.`, kind.code);
  }

  const project = realTarget(projectDir);
  const roots = [project, ...extraRoots.map(realTarget)];
  const root = roots.find((r) => inside(r, real));
  if (!root) {
    const extra = extraRoots.length ? ` or in ${extraRoots.join(', ')}` : '';
    throw new ToolError(
      `Walkthrough saves ${kind.noun}s only in the project folder${extra}. ${file} is outside. To allow another folder, add it to screenshotRoots in .walkthrough/config.local.yaml.`,
      kind.code,
    );
  }

  // No hidden files or folders (such as .git or .walkthrough).
  if (
    relative(root, real)
      .split(sep)
      .some((part) => part.startsWith('.'))
  ) {
    throw new ToolError(
      `Walkthrough does not save ${kind.noun}s in hidden files or folders, such as .git. ${file} is blocked.`,
      kind.code,
    );
  }
  return { path: real, display: inside(project, real) ? relative(project, real) : real };
}

export function checkScreenshotPath(
  file: string,
  projectDir: string,
  extraRoots: string[] = [],
): { path: string; display: string } {
  return checkOutputPath(file, projectDir, extraRoots, SCREENSHOT);
}

// Videos follow the same rules as screenshots. screenshotRoots applies to both.
export function checkMediaPath(
  file: string,
  projectDir: string,
  extraRoots: string[] = [],
): { path: string; display: string } {
  return checkOutputPath(file, projectDir, extraRoots, VIDEO);
}

// The largest slide image. Slides go to the page as data, so a huge file slows it down.
export const MAX_SLIDE_BYTES = 15 * 1024 * 1024;

// Checks an image for a presentation slide. Returns the full, real path.
// It must be in the project. Hidden folders are blocked, except .walkthrough, but not its
// saved logins and runs.
export function checkSlideImage(file: string, projectDir: string): string {
  const full = isAbsolute(file) ? file : resolve(projectDir, file);
  const ext = extname(full).toLowerCase();
  if (!(SLIDE_IMAGE_EXTENSIONS as readonly string[]).includes(ext)) {
    throw new ToolError(
      `A slide image ends with ${SLIDE_IMAGE_EXTENSIONS.join(', ')}. ${file} does not.`,
      'slide_blocked',
    );
  }
  let real: string;
  try {
    real = realpathSync(full);
  } catch {
    throw new ToolError(`The slide image ${file} does not exist.`, 'slide_blocked');
  }
  if (!statSync(real).isFile()) throw new ToolError(`${file} is not a file.`, 'slide_blocked');
  const project = realpathSync(projectDir);
  if (!inside(project, real)) {
    throw new ToolError(
      `A slide image must be in the project folder. ${file} is outside.`,
      'slide_blocked',
    );
  }
  const parts = relative(project, real).split(sep);
  const hidden = parts
    .slice(0, -1)
    .some((p, i) => p.startsWith('.') && !(i === 0 && p === '.walkthrough'));
  if (hidden || (parts[0] === '.walkthrough' && ['sessions', 'runs'].includes(parts[1] ?? ''))) {
    throw new ToolError(
      `Walkthrough does not show images from hidden or private folders. ${file} is blocked.`,
      'slide_blocked',
    );
  }
  if (statSync(real).size > MAX_SLIDE_BYTES) {
    throw new ToolError(
      `The slide image ${file} is larger than 15 MB. Use a smaller image.`,
      'slide_blocked',
    );
  }
  return real;
}
