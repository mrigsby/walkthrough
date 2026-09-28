// Lighthouse report categories. "agentic-browsing" is new in Lighthouse 13.
export const LH_CATEGORIES = [
  'performance',
  'accessibility',
  'best-practices',
  'seo',
  'agentic-browsing',
] as const;
export type LhCategory = (typeof LH_CATEGORIES)[number];

export const CATEGORY_LABELS: Record<string, string> = {
  performance: 'Performance',
  accessibility: 'Accessibility',
  'best-practices': 'Best Practices',
  seo: 'SEO',
  'agentic-browsing': 'Agentic Browsing',
};

export const LH_DEVICES = ['desktop', 'mobile'] as const;
export type LhDevice = (typeof LH_DEVICES)[number];

// How Lighthouse measures a flow step: a page load, a span of actions, or the page as it is.
export const LH_MODES = ['navigation', 'timespan', 'snapshot'] as const;
export type LhMode = (typeof LH_MODES)[number];

// The categories each mode can measure. A timespan has no page load or page state to check.
export const MODE_CATEGORIES: Record<LhMode, readonly LhCategory[]> = {
  navigation: LH_CATEGORIES,
  timespan: ['performance', 'best-practices'],
  snapshot: LH_CATEGORIES,
};
