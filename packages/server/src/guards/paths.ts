import { realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { ToolError } from '../errors.js';

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
