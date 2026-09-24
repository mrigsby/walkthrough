import { describe, expect, it } from 'vitest';
import { Recorder } from '../../src/record/recorder.js';
import { validatePlanText } from '../../src/run/plans.js';

function sample(): Recorder {
  const r = new Recorder('Log in', 'http://localhost:4321');
  const user = { role: 'textbox', name: 'Username' };
  r.add({ kind: 'fill', target: user, label: '"Username"', key: 'u', value: 'de' });
  r.add({ kind: 'fill', target: user, label: '"Username"', key: 'u', value: 'demo: "x"' });
  r.add({
    kind: 'fill',
    target: { role: 'textbox', name: 'Password' },
    label: '"Password"',
    key: 'p',
    secret: true,
    fieldName: 'password',
  });
  r.add({
    kind: 'click',
    target: { selector: '#login-form button[type="submit"]' },
    label: '"Log in"',
    key: 'b',
  });
  r.addExpectation('The Account page shows.');
  return r;
}

describe('Recorder', () => {
  it('writes a valid plan draft with one-line actions', () => {
    const yaml = sample().toYaml();
    expect(yaml).toContain('# yaml-language-server: $schema=../plan.schema.json');
    expect(yaml).toMatch(
      /action: \{ fill: \{ role: textbox, name: Username, value: 'demo: "x"' \} \}/,
    );
    expect(yaml).toContain('{{secret:PASSWORD}}');
    expect(yaml).toContain('expect: The Account page shows.');
    const result = validatePlanText(yaml);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (result.ok) expect(result.plan.steps).toHaveLength(3);
  });

  it('merges typing in the same field', () => {
    const r = sample();
    expect(r.steps.filter((s) => s.kind === 'fill')).toHaveLength(2);
    expect(r.steps[0]?.value).toBe('demo: "x"');
  });

  it('never keeps a password value', () => {
    const r = sample();
    expect(JSON.stringify(r.steps)).not.toContain('secret-value');
    expect(r.secrets).toEqual(['PASSWORD']);
  });

  it('turns the last typed field into a secret and drops the value', () => {
    const r = new Recorder('Coupon');
    r.add({
      kind: 'fill',
      target: { role: 'textbox', name: 'Coupon code' },
      label: '"Coupon code"',
      key: 'c',
      value: 'VIP-123',
    });
    expect(r.markLastSecret()).toBe('COUPON_CODE_SECRET');
    expect(r.toYaml()).not.toContain('VIP-123');
    expect(r.toYaml()).toContain('{{secret:COUPON_CODE_SECRET}}');
  });

  it('records a typed address, but not a page load right after a click', () => {
    const r = new Recorder('Nav', 'http://localhost:4321');
    r.add({ kind: 'click', target: { role: 'link', name: 'Cart' }, label: '"Cart"', key: 'c' });
    r.addNavigation('http://localhost:4321/cart');
    expect(r.steps).toHaveLength(1);
    const later = new Recorder('Nav', 'http://localhost:4321');
    later.addNavigation('http://localhost:4321/help.html?x=1');
    expect(later.steps[0]).toMatchObject({ kind: 'navigate', value: '/help.html?x=1' });
  });
});
