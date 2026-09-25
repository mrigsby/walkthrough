import type { A11yCheck } from '../run/run-store.js';
import type { A11yNode, A11yPass, A11yViolation, Impact } from './axe.js';
import { criterionByNumber } from './wcag.js';

// Walkthrough's own checks, written like axe rules so reports treat them the same way.
interface CustomRule {
  impact: Impact;
  help: string;
  description: string;
  wcag: string;
  tags: string[];
}

export const CUSTOM_RULES: Record<string, CustomRule> = {
  'keyboard-trap': {
    impact: 'critical',
    help: 'Keyboard focus must not get stuck',
    description: 'Checks that Tab and Shift+Tab can move focus away from every element.',
    wcag: '2.1.2',
    tags: ['wcag2a', 'wcag212', 'cat.keyboard'],
  },
  'keyboard-unreachable': {
    impact: 'serious',
    help: 'Elements you can click must be reachable with the Tab key',
    description: 'Checks for elements that respond to a click but cannot get keyboard focus.',
    wcag: '2.1.1',
    tags: ['wcag2a', 'wcag211', 'cat.keyboard'],
  },
  'focus-visible': {
    impact: 'serious',
    help: 'Keyboard focus must be visible',
    description: 'Checks that the screen changes when an element gets keyboard focus.',
    wcag: '2.4.7',
    tags: ['wcag2aa', 'wcag247', 'cat.keyboard'],
  },
  reflow: {
    impact: 'serious',
    help: 'Content must fit a 320px wide screen without sideways scrolling',
    description: 'Checks that the page does not scroll sideways at a width of 320 CSS pixels.',
    wcag: '1.4.10',
    tags: ['wcag21aa', 'wcag1410', 'cat.layout'],
  },
  'color-contrast-dark': {
    impact: 'serious',
    help: 'Text must have enough contrast in dark mode',
    description:
      'Checks color contrast with the dark color scheme, for problems that light mode does not have.',
    wcag: '1.4.3',
    tags: ['wcag2aa', 'wcag143', 'cat.color'],
  },
};

function violation(id: string, nodes: A11yNode[]): A11yViolation {
  const rule = CUSTOM_RULES[id] as CustomRule;
  return {
    id,
    impact: rule.impact,
    ruleImpact: rule.impact,
    help: rule.help,
    description: rule.description,
    helpUrl: criterionByNumber(rule.wcag)?.url ?? '',
    tags: rule.tags,
    nodes,
    nodeCount: nodes.length,
  };
}

// The custom checks that ran on this page, each with the elements that failed.
function results(check: A11yCheck): Array<[string, A11yNode[]]> {
  const out: Array<[string, A11yNode[]]> = [];
  const extra = check.checks ?? {};
  if (extra.keyboard) {
    out.push(['keyboard-trap', extra.keyboard.trap ?? []]);
    out.push(['keyboard-unreachable', extra.keyboard.unreachable]);
    out.push(['focus-visible', extra.keyboard.noVisibleFocus]);
  }
  if (extra.reflow) out.push(['reflow', extra.reflow.overflow ? extra.reflow.elements : []]);
  if (extra.darkMode) out.push(['color-contrast-dark', extra.darkMode.darkOnly]);
  return out;
}

// The custom checks that found problems on this page.
export function customViolations(check: A11yCheck): A11yViolation[] {
  return results(check)
    .filter(([, nodes]) => nodes.length > 0)
    .map(([id, nodes]) => violation(id, nodes));
}

// The custom checks that ran and found nothing.
export function customPasses(check: A11yCheck): A11yPass[] {
  return results(check)
    .filter(([, nodes]) => nodes.length === 0)
    .map(([id]) => ({
      id,
      ruleImpact: (CUSTOM_RULES[id] as CustomRule).impact,
      tags: (CUSTOM_RULES[id] as CustomRule).tags,
    }));
}
