import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { parse } from 'dotenv';
import { ToolError } from '../errors.js';

export const MASK = '****';
const TOKEN = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// The environment that secrets are for.
export interface SecretScope {
  name: string;
  // A protected environment never reads the plain .env file.
  protected: boolean;
  // Secret names that this environment reads under another name.
  rename: Record<string, string>;
}

// Holds secret values and removes them from any text we send back.
export class SecretStore {
  private readonly fileValues: Record<string, string>;
  // Every value in .env and .env.<name> files, to hide them all.
  private readonly allFileValues: string[];
  private readonly used = new Map<string, string>();

  constructor(
    readonly envFile: string,
    private readonly processEnv: NodeJS.ProcessEnv = process.env,
    readonly scope?: SecretScope,
  ) {
    const base = scope?.protected ? {} : SecretStore.readFile(envFile);
    const own = scope ? SecretStore.readFile(this.scopeFile(scope.name)) : {};
    this.fileValues = { ...base, ...own };
    this.allFileValues = SecretStore.envFiles(dirname(envFile)).flatMap((f) =>
      Object.values(SecretStore.readFile(f)),
    );
  }

  static forProject(projectDir: string, scope?: SecretScope): SecretStore {
    return new SecretStore(join(projectDir, '.walkthrough', '.env'), process.env, scope);
  }

  private scopeFile(name: string): string {
    return join(dirname(this.envFile), `.env.${name}`);
  }

  // .env and .env.<name> files in the folder. .env.example has no real values.
  private static envFiles(dir: string): string[] {
    try {
      return readdirSync(dir)
        .filter((f) => /^\.env(\.[A-Za-z0-9_-]+)?$/.test(f) && f !== '.env.example')
        .map((f) => join(dir, f));
    } catch {
      return [];
    }
  }

  private static readFile(file: string): Record<string, string> {
    try {
      return parse(readFileSync(file, 'utf8'));
    } catch {
      return {};
    }
  }

  get names(): string[] {
    return Object.keys(this.fileValues);
  }

  hasTokens(text: string): boolean {
    TOKEN.lastIndex = 0;
    return TOKEN.test(text);
  }

  // Swaps {{secret:NAME}} for the real value. The agent never sees the value.
  resolve(text: string): string {
    return text.replace(TOKEN, (_all, name: string) => {
      const lookup = this.scope?.rename[name] ?? name;
      const value = this.fileValues[lookup] ?? this.processEnv[lookup];
      if (value === undefined || value === '') throw this.missing(name, lookup);
      this.used.set(lookup, value);
      return value;
    });
  }

  private missing(name: string, lookup: string): ToolError {
    const scope = this.scope;
    if (!scope || (scope.name === 'development' && lookup === name)) {
      return new ToolError(
        `The secret ${name} is not set. Ask the developer to add ${name}=... to .walkthrough/.env.`,
        'secret_missing',
      );
    }
    const renamed =
      lookup === name ? '' : ` The "${scope.name}" environment reads it as ${lookup}.`;
    const files = scope.protected
      ? `.walkthrough/.env.${scope.name}`
      : `.walkthrough/.env.${scope.name} or .walkthrough/.env`;
    return new ToolError(
      `The secret ${name} is not set for the "${scope.name}" environment.${renamed} Ask the developer to add ${lookup}=... to ${files}.`,
      'secret_missing',
    );
  }

  // Values to hide: everything in .env, plus secrets from the environment that we used.
  private values(): string[] {
    const all = new Set([...this.allFileValues, ...this.used.values()]);
    // Very short values would hide normal words.
    return [...all].filter((v) => v.length >= 4);
  }

  // Replaces each secret value, and its common encoded forms, with ****.
  redact(text: string): string {
    let out = text;
    for (const value of this.values().sort((a, b) => b.length - a.length)) {
      const forms = new Set([
        value,
        encodeURIComponent(value),
        Buffer.from(value).toString('base64'),
        Buffer.from(value).toString('base64').replace(/=+$/, ''),
      ]);
      for (const form of forms) {
        if (form.length >= 4) out = out.split(form).join(MASK);
      }
    }
    return out;
  }
}

// Returns a copy of the data with every secret replaced by ****.
// Call it before escaping. Escaping changes how a secret looks, so a later search misses it.
export function redactDeep<T>(value: T, secrets: SecretStore | undefined): T {
  if (!secrets) return value;
  return JSON.parse(JSON.stringify(value), (_key, v) =>
    typeof v === 'string' ? secrets.redact(v) : v,
  ) as T;
}
