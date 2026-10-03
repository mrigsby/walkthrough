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
    // No baseUrl, so the plan runs in any environment.
    expect(yaml).not.toContain('baseUrl');
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

  it('records tab switches, popups, and new tabs', () => {
    const tabs: Record<string, { name: string; login: string; opener?: string }> = {
      t1: { name: 'main', login: 'main' },
      t2: { name: 't2', login: 'main', opener: 't1' },
      t3: { name: 't3', login: 'iso-ab12' },
      t4: { name: 'buyer', login: 'buyer' },
    };
    const r = new Recorder('Tabs', 'http://localhost:4321', (id) => tabs[id]);
    r.startTabs(['t1'], 't1');
    const click = (key: string) => ({
      kind: 'click' as const,
      target: { role: 'button', name: key },
      label: `"${key}"`,
      key,
    });
    r.add(click('Help'), 't1');
    r.add(click('Close help'), 't2');
    r.add(click('Back'), 't1');
    r.addNavigation('about:blank', 't3');
    r.addNavigation('http://localhost:4321/cart', 't3');
    r.add(click('Buy'), 't4');
    expect(r.steps.map((s) => s.kind)).toEqual([
      'click',
      'switchTab',
      'click',
      'switchTab',
      'click',
      'newTab',
      'newTab',
      'click',
    ]);
    const yaml = r.toYaml();
    expect(yaml).toContain('switchTab: { tab: newest, name: popup-1 }');
    expect(yaml).toContain('switchTab: main');
    expect(yaml).toContain('newTab: { name: tab-1, isolated: true, url: /cart }');
    expect(yaml).toContain('newTab: { name: buyer, isolated: buyer }');
    const result = validatePlanText(yaml);
    expect(result.ok, JSON.stringify(result)).toBe(true);
  });
});
