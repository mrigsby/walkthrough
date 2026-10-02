import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Config } from '../../src/config.js';
import { SecretStore } from '../../src/guards/secrets.js';
import { buildVars, hasVars, TokenResolver, varNames } from '../../src/page/tokens.js';
import { tempDir } from '../helpers/temp.js';

const env = (vars: Record<string, string>) =>
  ({
    vars: { shopper: 'Config Shopper', store: 'Config Store', city: 'Springfield' },
    environment: { name: 'staging', baseUrl: 'https://staging.example.com', vars },
  }) as unknown as Pick<Config, 'vars' | 'environment'>;

describe('buildVars', () => {
  it('uses config, then plan, then environment values, and adds the built-ins', () => {
    expect(
      buildVars(env({ store: 'Staging Store' }), {
        shopper: 'Plan Shopper',
        store: 'Plan Store',
        n: 5,
      }),
    ).toEqual({
      shopper: 'Plan Shopper',
      store: 'Staging Store',
      city: 'Springfield',
      n: '5',
      environment: 'staging',
      baseUrl: 'https://staging.example.com',
    });
  });
});

describe('TokenResolver', () => {
  const secrets = () => {
    const dir = tempDir('tokens');
    writeFileSync(join(dir, '.env'), 'APP_PASSWORD=pass-1234\n');
    return new SecretStore(join(dir, '.env'), {});
  };
  const vars = {
    shopper: 'Demo Shopper',
    email: 'demo+{{unique}}@example.com',
    login: '{{secret:APP_PASSWORD}}',
    environment: 'staging',
    baseUrl: 'https://staging.example.com',
  };

  it('fills in vars, then unique values, then secrets', () => {
    const t = new TokenResolver('k3x9p2', vars, secrets());
    expect(t.apply('{{var:shopper}} / {{ var:email }} / {{var:login}}')).toBe(
      'Demo Shopper / demo+k3x9p2@example.com / pass-1234',
    );
    expect(t.apply('{{var:baseUrl}}/cart on {{var:environment}}')).toBe(
      'https://staging.example.com/cart on staging',
    );
  });

  it('shows values without secrets', () => {
    const t = new TokenResolver('k3x9p2', vars, secrets());
    expect(t.display('{{var:login}} for {{var:shopper}}')).toBe(
      '{{secret:APP_PASSWORD}} for Demo Shopper',
    );
  });

  it('explains a missing var', () => {
    expect(() => new TokenResolver('k3x9p2', vars).apply('{{var:nope}}')).toThrow(
      /\{\{var:nope\}\} has no value\. Defined values: shopper, email/,
    );
  });

  it('puts tokens back for the log', () => {
    const t = new TokenResolver('k3x9p2', vars);
    expect(t.tokenizeForLog('Demo Shopper')).toBe('{{var:shopper}}');
    expect(t.tokenizeForLog('Hello Demo Shopper')).toBe('Hello Demo Shopper');
    expect(t.tokenizeForLog('https://x.example.com/u/%7B%7Bvar:shopper%7D%7D')).toBe(
      'https://x.example.com/u/{{var:shopper}}',
    );
    expect(t.tokenizeForLog('order k3x9p2')).toBe('order {{unique}}');
    // Built-in values stay as they are.
    expect(t.tokenizeForLog('staging')).toBe('staging');
  });

  it('finds var tokens', () => {
    expect(hasVars('a {{var:x}}')).toBe(true);
    expect(hasVars('a {{secret:x}}')).toBe(false);
    expect(varNames('{{var:a}} {{var:b}} {{ var:a }}')).toEqual(['a', 'b']);
  });
});
