import type { Config } from '../config.js';
import { RESERVED_VARS, stringValues, type VarsInput } from '../environments.js';
import { ToolError } from '../errors.js';
import type { SecretStore } from '../guards/secrets.js';
import { tokenizeUnique, withUnique } from './unique.js';

const VAR = /\{\{\s*var:([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
// new URL() encodes the braces.
const ENCODED_VAR = /%7B%7B\s*var:([A-Za-z_][A-Za-z0-9_]*)\s*%7D%7D/gi;

export function hasVars(text: string): boolean {
  VAR.lastIndex = 0;
  return VAR.test(text);
}

// The names of the {{var:NAME}} tokens in the text, in order, once each.
export function varNames(text: string): string[] {
  return [...new Set([...text.matchAll(VAR)].map((m) => m[1] as string))];
}

// Values for {{var:NAME}}: config, then the plan, then the environment. Later ones win.
export function buildVars(
  config: Pick<Config, 'vars' | 'environment'>,
  planVars?: VarsInput,
): Record<string, string> {
  return {
    ...config.vars,
    ...stringValues(planVars),
    ...config.environment.vars,
    environment: config.environment.name,
    baseUrl: config.environment.baseUrl ?? '',
  };
}

// Fills in {{var:NAME}}, {{unique}}, and {{secret:NAME}}.
export class TokenResolver {
  constructor(
    readonly unique: string,
    readonly vars: Readonly<Record<string, string>>,
    private readonly secrets?: SecretStore,
  ) {}

  private fillVars(text: string): string {
    return text.replace(VAR, (_all, name: string) => {
      const value = this.vars[name];
      if (value === undefined) {
        const defined = Object.keys(this.vars).join(', ');
        throw new ToolError(
          `{{var:${name}}} has no value. Defined values: ${defined}. Add "${name}" to "vars" in the plan or in .walkthrough/config.yaml. An environment can change it in its own "vars".`,
          'var_missing',
        );
      }
      return value;
    });
  }

  // The real value. Vars go first, so a var can hold {{unique}} or a secret.
  apply(text: string): string {
    const filled = withUnique(this.fillVars(text), this.unique);
    return this.secrets ? this.secrets.resolve(filled) : filled;
  }

  // The value for people and the agent. Secret tokens stay as they are.
  display(text: string): string {
    return withUnique(this.fillVars(text), this.unique);
  }

  // Puts tokens back, so a record can run again with other values.
  tokenizeForLog(text: string): string {
    let out = text.replace(ENCODED_VAR, (_all, name: string) => `{{var:${name}}}`);
    // A value that is all one var, like a typed user name. Short values could be normal words.
    for (const [name, value] of Object.entries(this.vars)) {
      if (!RESERVED_VARS.includes(name) && value.length >= 4 && out === value) {
        out = `{{var:${name}}}`;
        break;
      }
    }
    return tokenizeUnique(out, this.unique);
  }
}
