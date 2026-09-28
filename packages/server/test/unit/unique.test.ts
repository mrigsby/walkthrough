import { describe, expect, it } from 'vitest';
import { hasUnique, newUnique, tokenizeUnique, withUnique } from '../../src/page/unique.js';

describe('{{unique}}', () => {
  it('makes short, different values that start with a letter', () => {
    const values = new Set(Array.from({ length: 50 }, () => newUnique()));
    expect(values.size).toBeGreaterThan(45);
    for (const value of values) expect(value).toMatch(/^[a-z][a-z0-9]{5}$/);
  });

  it('puts the value in and takes it out again', () => {
    expect(hasUnique('demo+{{unique}}@example.com')).toBe(true);
    expect(hasUnique('demo+{{ unique }}@example.com')).toBe(true);
    expect(hasUnique('demo@example.com')).toBe(false);
    expect(withUnique('demo+{{unique}}@x.com and {{ unique }}', 'k3x9p2')).toBe(
      'demo+k3x9p2@x.com and k3x9p2',
    );
    expect(tokenizeUnique('http://localhost/order/k3x9p2?u=k3x9p2', 'k3x9p2')).toBe(
      'http://localhost/order/{{unique}}?u={{unique}}',
    );
    expect(tokenizeUnique('http://localhost/a/%7B%7Bunique%7D%7D', 'k3x9p2')).toBe(
      'http://localhost/a/{{unique}}',
    );
  });
});
