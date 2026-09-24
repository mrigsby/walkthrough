import { describe, expect, it } from 'vitest';
import { nodeVersionOk } from '../../src/version.js';

describe('nodeVersionOk', () => {
  it('accepts supported versions', () => {
    expect(nodeVersionOk('22.12.0')).toBe(true);
    expect(nodeVersionOk('24.10.0')).toBe(true);
  });

  it('rejects older versions', () => {
    expect(nodeVersionOk('22.11.9')).toBe(false);
    expect(nodeVersionOk('20.18.0')).toBe(false);
  });
});
