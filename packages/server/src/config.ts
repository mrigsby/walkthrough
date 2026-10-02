import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';
import {
  CHECKS,
  type CheckName,
  checksSchema,
  STANDARDS,
  type Standard,
} from './audit/standards.js';
import {
  DEVELOPMENT,
  defaultColor,
  defaultLabel,
  type Environment,
  type EnvironmentFile,
  environmentFileSchema,
  envNameSchema,
  originOf,
  stringValues,
  varsSchema,
} from './environments.js';
import { issueMessage, ToolError } from './errors.js';
import { DEFAULT_ORIGINS, OriginGuard } from './guards/origins.js';
import {
  LH_CATEGORIES,
  LH_DEVICES,
  type LhCategory,
  type LhDevice,
} from './lighthouse/categories.js';
import { VIDEO_FORMATS, type VideoFormat } from './video/formats.js';

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
  // Folders outside the project where screenshots and videos may go.
  screenshotRoots: string[];
  // Show cookie, storage, and header values in tool replies. Only from config.local.yaml.
  allowSecretValues: boolean;
  // Only from config.local.yaml.
  ffmpegPath?: string;
  accessibility: AccessibilityConfig;
  video: VideoConfig;
  lighthouse: LighthouseConfig;
  // The environment these settings are for. baseUrl, allowedOrigins, and actionTimeoutMs follow it.
  environment: Environment;
  environments: Record<string, Environment>;
  // The environment to use when nothing else picks one.
  defaultEnvironment: string;
  // Project-wide values for {{var:NAME}}.
  vars: Record<string, string>;
  warnings: string[];
}

export interface VideoConfig {
  runFormat: VideoFormat;
  bugFormat: VideoFormat;
  width: number;
  gifWidth: number;
  gifFps: number;
  maxGifSeconds: number;
  // Wait time longer than this is cut down to this.
  idleSeconds: number;
  // Seconds kept for bug clips. 0 turns them off.
  replaySeconds: number;
  showPanel: boolean;
  pointer: boolean;
  captions: boolean;
}

export interface LighthouseConfig {
  device: LhDevice;
  categories: LhCategory[];
}

export interface AccessibilityConfig {
  standard: Standard;
  bestPractices: boolean;
  // Extra checks that a full scan runs.
  checks: Record<CheckName, boolean>;
  maxScreenshots: number;
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
    accessibility: z
      .object({
        standard: z.enum(STANDARDS).optional(),
        bestPractices: z.boolean().optional(),
        checks: checksSchema.optional(),
        maxScreenshots: z.number().int().min(0).max(200).optional(),
      })
      .strict()
      .optional(),
    video: z
      .object({
        runFormat: z.enum(VIDEO_FORMATS).optional(),
        bugFormat: z.enum(VIDEO_FORMATS).optional(),
        width: z.number().int().min(320).max(3840).optional(),
        gifWidth: z.number().int().min(200).max(1920).optional(),
        gifFps: z.number().int().min(1).max(30).optional(),
        maxGifSeconds: z.number().int().min(5).max(600).optional(),
        idleSeconds: z.number().min(0.2).max(10).optional(),
        replaySeconds: z.number().int().min(0).max(120).optional(),
        showPanel: z.boolean().optional(),
        pointer: z.boolean().optional(),
        captions: z.boolean().optional(),
      })
      .strict()
      .optional(),
    lighthouse: z
      .object({
        device: z.enum(LH_DEVICES).optional(),
        categories: z.array(z.enum(LH_CATEGORIES)).min(1).optional(),
      })
      .strict()
      .optional(),
    environment: envNameSchema.optional(),
    vars: varsSchema.optional(),
    environments: z.record(envNameSchema, environmentFileSchema).optional(),
  })
  .loose();

// Risky settings. Only the local, uncommitted file may turn these on.
const LOCAL_ONLY = [
  'allowEvaluate',
  'uploadsRoot',
  'screenshotRoots',
  'allowSecretValues',
  'ffmpegPath',
] as const;
const localSchema = sharedSchema.extend({
  allowEvaluate: z.boolean().optional(),
  uploadsRoot: z.string().optional(),
  screenshotRoots: z.array(z.string().min(1)).optional(),
  allowSecretValues: z.boolean().optional(),
  // A program path in a shared file could run any program, so it is local only.
  ffmpegPath: z.string().min(1).optional(),
});

type LocalFile = z.infer<typeof localSchema>;
type SharedFile = z.infer<typeof sharedSchema>;

const SECRET_TOKEN = /\{\{\s*secret:[A-Za-z_][A-Za-z0-9_]*\s*\}\}/;

// Merges each environment of the two files, key by key. Development always exists.
function mergeEnvironments(
  shared: SharedFile,
  local: LocalFile,
  warnings: string[],
): Record<string, Environment> {
  const names = new Set([
    DEVELOPMENT,
    ...Object.keys(shared.environments ?? {}),
    ...Object.keys(local.environments ?? {}),
  ]);
  const out: Record<string, Environment> = {};
  for (const name of names) {
    const s: EnvironmentFile | undefined = shared.environments?.[name];
    const l: EnvironmentFile | undefined = local.environments?.[name];
    const m = { ...s, ...l };
    const isDev = name === DEVELOPMENT;
    const baseUrl = m.baseUrl ?? (isDev ? (local.baseUrl ?? shared.baseUrl) : undefined);
    if (!baseUrl && !isDev) {
      throw new ToolError(
        `The environment "${name}" needs a baseUrl, like baseUrl: https://${name}.example.com.`,
        'config_invalid',
      );
    }
    const isProtected = m.protected ?? name === 'production';
    if (l?.protected === false && (s?.protected ?? name === 'production')) {
      warnings.push(
        `config.local.yaml turns off the protection of the "${name}" environment. Walkthrough does not ask before it works there.`,
      );
    }
    let ignoreHttpsErrors = m.ignoreHttpsErrors ?? false;
    if (ignoreHttpsErrors && isProtected) {
      warnings.push(
        `Walkthrough ignores "ignoreHttpsErrors" for the "${name}" environment, because it is protected.`,
      );
      ignoreHttpsErrors = false;
    }
    // config.yaml goes into Git, so its values must not be secrets.
    for (const [header, value] of Object.entries(s?.headers ?? {})) {
      if (!SECRET_TOKEN.test(value)) {
        warnings.push(
          `The header "${header}" of the "${name}" environment in .walkthrough/config.yaml has a plain value. Put the value in .walkthrough/.env.${name}, and use {{secret:NAME}} in config.yaml.`,
        );
      }
    }
    if (s?.httpCredentials && !SECRET_TOKEN.test(s.httpCredentials.password)) {
      warnings.push(
        `The httpCredentials password of the "${name}" environment in .walkthrough/config.yaml is a plain value. Put it in .walkthrough/.env.${name}, and use {{secret:NAME}} in config.yaml.`,
      );
    }
    let source = 'built in';
    if (s && l) source = 'config.yaml and config.local.yaml';
    else if (s) source = 'config.yaml';
    else if (l) source = 'config.local.yaml';
    else if (isDev && baseUrl) source = 'baseUrl in config.yaml';
    out[name] = {
      name,
      label: m.label ?? defaultLabel(name),
      color: m.color ?? defaultColor(name),
      baseUrl,
      allowedOrigins: m.allowedOrigins ?? [],
      vars: { ...stringValues(s?.vars), ...stringValues(l?.vars) },
      secrets: { ...s?.secrets, ...l?.secrets },
      protected: isProtected,
      headers: { ...s?.headers, ...l?.headers },
      httpCredentials: m.httpCredentials,
      ignoreHttpsErrors,
      actionTimeoutMs: m.actionTimeoutMs,
      source,
    };
  }
  return out;
}

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
    .map((issue) => `${issue.path.join('.') || '(top)'}: ${issueMessage(issue)}`)
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

// Reads the settings for one environment. Without a name, it uses the default environment.
export function loadConfig(
  projectDir: string,
  projectDirSource = 'current folder',
  environmentName?: string,
): Config {
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
  // Merge key by key, so the local file can change one check only.
  const a11y = {
    ...shared.accessibility,
    ...local.accessibility,
    checks: { ...shared.accessibility?.checks, ...local.accessibility?.checks },
  };
  const video = { ...shared.video, ...local.video };
  const lighthouse = { ...shared.lighthouse, ...local.lighthouse };

  const fromProject = (dir: string) => (isAbsolute(dir) ? dir : resolve(projectDir, dir));
  const uploadsRoot = local.uploadsRoot ? fromProject(local.uploadsRoot) : projectDir;
  const screenshotRoots = (local.screenshotRoots ?? []).map(fromProject);

  const environments = mergeEnvironments(shared, local, warnings);
  const names = Object.keys(environments).join(', ');
  const defaultEnvironment = local.environment ?? shared.environment ?? DEVELOPMENT;
  if (!environments[defaultEnvironment]) {
    throw new ToolError(
      `The default environment "${defaultEnvironment}" is not in "environments". Environments: ${names}.`,
      'config_invalid',
    );
  }
  const envName = environmentName ?? defaultEnvironment;
  const environment = environments[envName];
  if (!environment) {
    throw new ToolError(
      `There is no environment "${envName}". Environments: ${names}. Add it under "environments" in .walkthrough/config.yaml.`,
      'environment_unknown',
    );
  }
  // The shared list, the environment's own sites, and the site of its base URL.
  const allowedOrigins = [
    ...new Set([...(merged.allowedOrigins ?? DEFAULT_ORIGINS), ...environment.allowedOrigins]),
  ];
  const envOrigin = originOf(environment.baseUrl);
  if (envOrigin && !new OriginGuard(allowedOrigins).isAllowed(envOrigin)) {
    allowedOrigins.push(envOrigin);
  }

  // Headless is useful for tests and CI.
  const envHeadless = process.env.UIWALK_HEADLESS;
  const headless = envHeadless ? envHeadless !== '0' : (merged.browser.headless ?? false);
  // Nobody can see a panel in a hidden browser. Tests can still force it on.
  const panel = (merged.panel ?? true) && (!headless || process.env.UIWALK_FORCE_PANEL === '1');

  return {
    projectDir,
    projectDirSource,
    baseUrl: environment.baseUrl,
    allowedOrigins,
    browser: {
      headless,
      slowMo: merged.browser.slowMo ?? 0,
      executablePath: merged.browser.executablePath,
    },
    dialogs: merged.dialogs ?? 'ask',
    actionTimeoutMs: environment.actionTimeoutMs ?? merged.actionTimeoutMs ?? 10_000,
    askTimeoutSec: merged.askTimeoutSec,
    panel,
    highlightMs: merged.highlightMs ?? (headless ? 0 : 600),
    allowEvaluate: local.allowEvaluate ?? false,
    uploadsRoot,
    screenshotRoots,
    allowSecretValues: local.allowSecretValues ?? false,
    ffmpegPath: local.ffmpegPath ? fromProject(local.ffmpegPath) : undefined,
    accessibility: {
      standard: a11y.standard ?? 'wcag22aa',
      bestPractices: a11y.bestPractices ?? true,
      checks: Object.fromEntries(
        CHECKS.map((c) => [c, (a11y.checks as Record<string, boolean | undefined>)[c] ?? true]),
      ) as Record<CheckName, boolean>,
      maxScreenshots: a11y.maxScreenshots ?? 25,
    },
    video: {
      runFormat: video.runFormat ?? 'mp4',
      bugFormat: video.bugFormat ?? 'gif',
      width: video.width ?? 1280,
      gifWidth: video.gifWidth ?? 800,
      gifFps: video.gifFps ?? 10,
      maxGifSeconds: video.maxGifSeconds ?? 60,
      idleSeconds: video.idleSeconds ?? 1,
      replaySeconds: video.replaySeconds ?? 15,
      showPanel: video.showPanel ?? false,
      pointer: video.pointer ?? true,
      captions: video.captions ?? true,
    },
    lighthouse: {
      device: lighthouse.device ?? 'desktop',
      categories: lighthouse.categories ?? ['performance', 'best-practices', 'seo'],
    },
    environment,
    environments,
    defaultEnvironment,
    vars: { ...stringValues(shared.vars), ...stringValues(local.vars) },
    warnings,
  };
}
