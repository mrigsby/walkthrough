import { z } from 'zod';
import type { Config } from './config.js';
import { ToolError } from './errors.js';
import { type DeniedOrigin, OriginGuard } from './guards/origins.js';

export const DEVELOPMENT = 'development';

// Names of environments, like "staging".
export const ENV_NAME = /^[a-z][a-z0-9-]*$/;
export const envNameSchema = z
  .string()
  .regex(ENV_NAME, 'Use lowercase letters, numbers, and dashes, like "staging".');

// Names of values for {{var:NAME}} and of secrets.
export const VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Walkthrough sets these values itself.
export const RESERVED_VARS: readonly string[] = ['environment', 'baseUrl'];

const varName = z
  .string()
  .regex(VAR_NAME, 'Use letters, numbers, and underscores, like "shopper".')
  .refine((name) => !RESERVED_VARS.includes(name), 'This name is reserved. Walkthrough sets it.');
export const varsSchema = z.record(varName, z.union([z.string(), z.number(), z.boolean()]));
export type VarsInput = z.infer<typeof varsSchema>;

const secretName = z
  .string()
  .regex(VAR_NAME, 'Use letters, numbers, and underscores, like "APP_PASSWORD".');
const headerName = z.string().regex(/^[A-Za-z0-9!#$%&'*+.^_`|~-]+$/, 'Use a header name.');

// One environment, as written in config.yaml or config.local.yaml.
export const environmentFileSchema = z
  .object({
    baseUrl: z.url().optional(),
    label: z.string().min(1).max(40).optional(),
    color: z
      .string()
      .regex(/^#(?:[0-9a-fA-F]{3}){1,2}$/, 'Use a hex color, like "#b45309".')
      .optional(),
    allowedOrigins: z.array(z.string()).optional(),
    vars: varsSchema.optional(),
    secrets: z.record(secretName, secretName).optional(),
    protected: z.boolean().optional(),
    headers: z.record(headerName, z.string()).optional(),
    httpCredentials: z
      .object({ username: z.string().min(1), password: z.string().min(1) })
      .strict()
      .optional(),
    ignoreHttpsErrors: z.boolean().optional(),
    actionTimeoutMs: z.number().int().min(1000).max(120_000).optional(),
  })
  .strict();
export type EnvironmentFile = z.infer<typeof environmentFileSchema>;

// One environment after the two files are merged.
export interface Environment {
  name: string;
  label: string;
  color: string;
  // Development may have none.
  baseUrl?: string;
  // Sites this environment adds to the shared list.
  allowedOrigins: string[];
  vars: Record<string, string>;
  // Secret names that this environment reads under another name.
  secrets: Record<string, string>;
  protected: boolean;
  headers: Record<string, string>;
  httpCredentials?: { username: string; password: string };
  ignoreHttpsErrors: boolean;
  actionTimeoutMs?: number;
  // Where it is set, for messages.
  source: string;
}

const COLORS: Record<string, string> = {
  development: '#15803d',
  staging: '#b45309',
  production: '#b91c1c',
};

export function defaultColor(name: string): string {
  return COLORS[name] ?? '#4b5563';
}

export function defaultLabel(name: string): string {
  return name.charAt(0).toUpperCase() + name.slice(1);
}

export function stringValues(values?: VarsInput): Record<string, string> {
  return Object.fromEntries(Object.entries(values ?? {}).map(([k, v]) => [k, String(v)]));
}

export function originOf(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}

// "staging (https://staging.example.com)"
export function describeEnvironment(env: Pick<Environment, 'name' | 'baseUrl'>): string {
  return env.baseUrl ? `${env.name} (${env.baseUrl})` : env.name;
}

// The start page of a plan: a full URL, or a path from the environment's base URL.
export function startUrl(
  planBase: string | undefined,
  envBase: string | undefined,
): string | undefined {
  if (!planBase) return envBase;
  if (!planBase.startsWith('/')) return planBase;
  if (!envBase) {
    throw new ToolError(
      `The plan starts at the path ${planBase}, but the environment has no baseUrl. Set baseUrl in .walkthrough/config.yaml.`,
      'bad_input',
    );
  }
  return new URL(planBase, envBase).href;
}

// Moves a URL from one environment to the same place on another one.
// Returns undefined when the URL is not on the first environment.
export function rebaseUrl(url: string, fromBase?: string, toBase?: string): string | undefined {
  if (!fromBase || !toBase) return undefined;
  let here: URL;
  let from: URL;
  let to: URL;
  try {
    here = new URL(url);
    from = new URL(fromBase);
    to = new URL(toBase);
  } catch {
    return undefined;
  }
  if (here.origin !== from.origin) return undefined;
  // A base path, like /app/, moves too.
  const fromPath = from.pathname.replace(/\/+$/, '');
  const toPath = to.pathname.replace(/\/+$/, '');
  let path = here.pathname;
  if (fromPath && (path === fromPath || path.startsWith(`${fromPath}/`))) {
    path = toPath + path.slice(fromPath.length);
  } else if (fromPath) {
    return undefined;
  }
  return `${to.origin}${path || '/'}${here.search}${here.hash}`;
}

// Moves a URL from any other environment to the one these settings are for.
// The longest base URL that matches wins. Other URLs stay as they are.
export function rebaseToEnvironment(
  url: string,
  config: Pick<Config, 'environment' | 'environments'>,
): string {
  const target = config.environment.baseUrl;
  const others = Object.values(config.environments)
    .filter((env) => env.name !== config.environment.name && env.baseUrl)
    .sort((a, b) => (b.baseUrl?.length ?? 0) - (a.baseUrl?.length ?? 0));
  for (const env of others) {
    const moved = rebaseUrl(url, env.baseUrl, target);
    if (moved) return moved;
  }
  return url;
}

// Request rules for the site of an environment, with the secrets filled in.
export interface EnvNetwork {
  // Only requests to this site get the headers and the login.
  origin: string;
  headers: Record<string, string>;
  credentials?: { username: string; password: string };
}

// Fills in the secrets of an environment's headers and login.
// A secret that is not set leaves out that header, with a warning.
export function environmentNetwork(
  env: Environment,
  resolve: (text: string) => string,
  warnings: string[],
): EnvNetwork | undefined {
  const origin = originOf(env.baseUrl);
  if (!origin) return undefined;
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(env.headers)) {
    try {
      headers[name] = resolve(value);
    } catch (error) {
      warnings.push(`Walkthrough does not send the header "${name}": ${(error as Error).message}`);
    }
  }
  let credentials: EnvNetwork['credentials'];
  if (env.httpCredentials) {
    try {
      credentials = {
        username: resolve(env.httpCredentials.username),
        password: resolve(env.httpCredentials.password),
      };
    } catch (error) {
      warnings.push(`Walkthrough does not use the basic auth login: ${(error as Error).message}`);
    }
  }
  if (Object.keys(headers).length === 0 && !credentials) return undefined;
  return { origin, headers, credentials };
}

// What the secret store needs to know about an environment.
export function secretScope(env: Environment): {
  name: string;
  protected: boolean;
  rename: Record<string, string>;
} {
  return { name: env.name, protected: env.protected, rename: env.secrets };
}

// The badge in the panel. None when the project has only development.
export function environmentBadge(
  config: Pick<Config, 'environment' | 'environments'>,
): { label: string; color: string } | null {
  const only = Object.keys(config.environments).length === 1;
  if (only && config.environment.name === DEVELOPMENT) return null;
  return { label: config.environment.label, color: config.environment.color };
}

// Sites that stay blocked: the other environments, and a protected one that is not confirmed.
export function deniedOrigins(
  config: Pick<Config, 'environment' | 'environments'>,
  confirmed: ReadonlySet<string> = new Set(),
): DeniedOrigin[] {
  const active = config.environment;
  const here = originOf(active.baseUrl);
  const out = new Map<string, string>();
  for (const env of Object.values(config.environments)) {
    const origin = originOf(env.baseUrl);
    if (!origin || out.has(origin)) continue;
    if (env.name === active.name) {
      if (env.protected && !confirmed.has(env.name)) {
        out.set(
          origin,
          `"${env.name}" is a protected environment, and the developer has not confirmed it yet. Call the environment tool with action "use" and name "${env.name}". The developer confirms it in the browser.`,
        );
      }
      continue;
    }
    // Two environments on one site cannot be told apart by the site.
    if (origin === here) continue;
    out.set(
      origin,
      `${origin} is the site of the "${env.name}" environment, and this session uses "${active.name}". To test ${env.name}, call the environment tool with action "use" and name "${env.name}".`,
    );
  }
  return [...out].map(([origin, reason]) => ({ origin, reason }));
}

export function environmentGuard(
  config: Pick<Config, 'allowedOrigins' | 'environment' | 'environments'>,
  confirmed: ReadonlySet<string> = new Set(),
): OriginGuard {
  return new OriginGuard(config.allowedOrigins, deniedOrigins(config, confirmed));
}
