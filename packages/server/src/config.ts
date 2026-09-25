import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import { ToolError } from './errors.js';
import { DEFAULT_ORIGINS } from './guards/origins.js';

export type DialogPolicy = 'ask' | 'accept' | 'dismiss';

export interface Config {
  projectDir: string;
  projectDirSource: string;
  baseUrl?: string;
  allowedOrigins: string[];
  browser: {
    headless: boolean;
    slowMo: number;
    executablePath?: string;
  };
  dialogs: DialogPolicy;
  actionTimeoutMs: number;
  askTimeoutSec?: number;
  // The developer panel, and how long to highlight an element before an action.
  panel: boolean;
  highlightMs: number;
  // Only read from config.local.yaml.
  allowEvaluate: boolean;
  uploadsRoot: string;
  // Folders outside the project where screenshots may go.
  screenshotRoots: string[];
  warnings: string[];
}

// Settings that anyone can commit.
const sharedSchema = z
  .object({
    baseUrl: z.url().optional(),
    allowedOrigins: z.array(z.string()).min(1).optional(),
    browser: z
      .object({
        headless: z.boolean().optional(),
        slowMo: z.number().int().min(0).max(5000).optional(),
        executablePath: z.string().optional(),
      })
      .optional(),
    dialogs: z.enum(['ask', 'accept', 'dismiss']).optional(),
    actionTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
    askTimeoutSec: z.number().int().min(10).max(3600).optional(),
    panel: z.boolean().optional(),
    highlightMs: z.number().int().min(0).max(5000).optional(),
  })
  .loose();

// Risky settings. Only the local, uncommitted file may turn these on.
const LOCAL_ONLY = ['allowEvaluate', 'uploadsRoot', 'screenshotRoots'] as const;
const localSchema = sharedSchema.extend({
  allowEvaluate: z.boolean().optional(),
  uploadsRoot: z.string().optional(),
  screenshotRoots: z.array(z.string().min(1)).optional(),
});

type LocalFile = z.infer<typeof localSchema>;

function readYaml(file: string): Record<string, unknown> {
  if (!existsSync(file)) return {};
  try {
    const data = parse(readFileSync(file, 'utf8'));
    return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
  } catch (error) {
    throw new ToolError(`Could not read ${file}: ${(error as Error).message}`, 'config_invalid');
  }
}

function validate<T>(schema: z.ZodType<T>, data: unknown, file: string): T {
  const result = schema.safeParse(data);
  if (result.success) return result.data;
  const problems = result.error.issues
    .map((issue) => `${issue.path.join('.') || '(top)'}: ${issue.message}`)
    .join('. ');
  throw new ToolError(`The settings in ${file} are not valid. ${problems}`, 'config_invalid');
}

export interface ProjectDirOptions {
  argument?: string;
  roots?: string[];
  env?: NodeJS.ProcessEnv;
  cwd?: string;
}

// Finds the project folder. The first match wins.
export function resolveProjectDir(options: ProjectDirOptions = {}): {
  dir: string;
  source: string;
} {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const candidates: Array<[string | undefined, string]> = [
    [options.argument, 'tool argument'],
    [env.UIWALK_PROJECT_DIR, 'UIWALK_PROJECT_DIR'],
    [env.CLAUDE_PROJECT_DIR, 'CLAUDE_PROJECT_DIR'],
    [options.roots?.[0], 'MCP roots'],
  ];
  for (const [value, source] of candidates) {
    if (!value || value.includes('${')) continue;
    const dir = value.startsWith('file:') ? fileURLToPath(value) : resolve(cwd, value);
    return { dir, source };
  }
  return { dir: cwd, source: 'current folder' };
}

export function loadConfig(projectDir: string, projectDirSource = 'current folder'): Config {
  const folder = join(projectDir, '.walkthrough');
  const sharedFile = join(folder, 'config.yaml');
  const localFile = join(folder, 'config.local.yaml');
  const warnings: string[] = [];

  const sharedRaw = readYaml(sharedFile);
  for (const key of LOCAL_ONLY) {
    if (key in sharedRaw) {
      warnings.push(
        `Walkthrough ignores "${key}" in .walkthrough/config.yaml. For safety, set it in .walkthrough/config.local.yaml. Git does not track that file.`,
      );
      delete sharedRaw[key];
    }
  }
  const shared = validate(sharedSchema, sharedRaw, sharedFile);
  const local: LocalFile = validate(localSchema, readYaml(localFile), localFile);
  const merged = { ...shared, ...local, browser: { ...shared.browser, ...local.browser } };

  const fromProject = (dir: string) => (isAbsolute(dir) ? dir : resolve(projectDir, dir));
  const uploadsRoot = local.uploadsRoot ? fromProject(local.uploadsRoot) : projectDir;
  const screenshotRoots = (local.screenshotRoots ?? []).map(fromProject);

  // Headless is useful for tests and CI.
  const envHeadless = process.env.UIWALK_HEADLESS;
  const headless = envHeadless ? envHeadless !== '0' : (merged.browser.headless ?? false);
  // Nobody can see a panel in a hidden browser. Tests can still force it on.
  const panel = (merged.panel ?? true) && (!headless || process.env.UIWALK_FORCE_PANEL === '1');

  return {
    projectDir,
    projectDirSource,
    baseUrl: merged.baseUrl,
    allowedOrigins: merged.allowedOrigins ?? DEFAULT_ORIGINS,
    browser: {
      headless,
      slowMo: merged.browser.slowMo ?? 0,
      executablePath: merged.browser.executablePath,
    },
    dialogs: merged.dialogs ?? 'ask',
    actionTimeoutMs: merged.actionTimeoutMs ?? 10_000,
    askTimeoutSec: merged.askTimeoutSec,
    panel,
    highlightMs: merged.highlightMs ?? (headless ? 0 : 600),
    allowEvaluate: local.allowEvaluate ?? false,
    uploadsRoot,
    screenshotRoots,
    warnings,
  };
}
