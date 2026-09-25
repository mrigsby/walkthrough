import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'dotenv';
import { ToolError } from '../errors.js';

export const MASK = '****';
const TOKEN = /\{\{\s*secret:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

// Holds secret values and removes them from any text we send back.
export class SecretStore {
  private readonly fileValues: Record<string, string>;
  private readonly used = new Map<string, string>();

  constructor(
    readonly envFile: string,
    private readonly processEnv: NodeJS.ProcessEnv = process.env,
  ) {
    this.fileValues = SecretStore.readFile(envFile);
  }

  static forProject(projectDir: string): SecretStore {
    return new SecretStore(join(projectDir, '.walkthrough', '.env'));
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
      const value = this.fileValues[name] ?? this.processEnv[name];
      if (value === undefined || value === '') {
        throw new ToolError(
          `The secret ${name} is not set. Ask the developer to add ${name}=... to .walkthrough/.env.`,
          'secret_missing',
        );
      }
      this.used.set(name, value);
      return value;
    });
  }

  // Values to hide: everything in .env, plus secrets from the environment that we used.
  private values(): string[] {
    const all = new Set([...Object.values(this.fileValues), ...this.used.values()]);
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
