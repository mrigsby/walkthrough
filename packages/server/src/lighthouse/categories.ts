// Lighthouse report categories. "agentic-browsing" is new in Lighthouse 13.
export const LH_CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
  'agentic-browsing',
] as const;
export type LhCategory = (typeof LH_CATEGORIES)[number];

export const LH_DEVICES = ['desktop', 'mobile'] as const;
export type LhDevice = (typeof LH_DEVICES)[number];
