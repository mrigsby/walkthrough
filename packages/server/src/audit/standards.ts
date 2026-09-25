import { z } from 'zod';

// The standards an audit can check, and the axe-core tags for each one.
export const STANDARDS = ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] as const;
export type Standard = (typeof STANDARDS)[number];

export const STANDARD_LABELS: Record<Standard, string> = {
  wcag2a: 'WCAG 2.0 A',
  wcag2aa: 'WCAG 2.0 AA',
  wcag21aa: 'WCAG 2.1 AA',
  wcag22aa: 'WCAG 2.2 AA',
};

const TAGS: Record<Standard, string[]> = {
  wcag2a: ['wcag2a'],
  wcag2aa: ['wcag2a', 'wcag2aa'],
  wcag21aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'],
  wcag22aa: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
};

// The axe-core tags to run. Best practices are extra rules that are not in WCAG.
export function standardTags(standard: Standard, bestPractices: boolean): string[] {
  return bestPractices ? [...TAGS[standard], 'best-practice'] : [...TAGS[standard]];
}

// The extra checks that can run with an audit.
export const CHECKS = ['keyboard', 'darkMode', 'reflow', 'frames', 'screenshots'] as const;
export type CheckName = (typeof CHECKS)[number];

// Turns checks on or off, like { keyboard: true, darkMode: false }.
export const checksSchema = z
  .object(Object.fromEntries(CHECKS.map((c) => [c, z.boolean().optional()])))
  .strict()
  .describe('Turn extra checks on or off: keyboard, darkMode, reflow, frames, screenshots.');
