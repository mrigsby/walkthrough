// WCAG 2.2 success criteria at levels A and AA, and how axe-core tags map to them.

export type Principle = 'Perceivable' | 'Operable' | 'Understandable' | 'Robust';

export interface Criterion {
  number: string;
  name: string;
  level: 'A' | 'AA';
  principle: Principle;
  url: string;
}

const LIST: Array<[string, string, 'A' | 'AA']> = [
  ['1.1.1', 'Non-text Content', 'A'],
  ['1.2.1', 'Audio-only and Video-only (Prerecorded)', 'A'],
  ['1.2.2', 'Captions (Prerecorded)', 'A'],
  ['1.2.3', 'Audio Description or Media Alternative (Prerecorded)', 'A'],
  ['1.2.4', 'Captions (Live)', 'AA'],
  ['1.2.5', 'Audio Description (Prerecorded)', 'AA'],
  ['1.3.1', 'Info and Relationships', 'A'],
  ['1.3.2', 'Meaningful Sequence', 'A'],
  ['1.3.3', 'Sensory Characteristics', 'A'],
  ['1.3.4', 'Orientation', 'AA'],
  ['1.3.5', 'Identify Input Purpose', 'AA'],
  ['1.4.1', 'Use of Color', 'A'],
  ['1.4.2', 'Audio Control', 'A'],
  ['1.4.3', 'Contrast (Minimum)', 'AA'],
  ['1.4.4', 'Resize Text', 'AA'],
  ['1.4.5', 'Images of Text', 'AA'],
  ['1.4.10', 'Reflow', 'AA'],
  ['1.4.11', 'Non-text Contrast', 'AA'],
  ['1.4.12', 'Text Spacing', 'AA'],
  ['1.4.13', 'Content on Hover or Focus', 'AA'],
  ['2.1.1', 'Keyboard', 'A'],
  ['2.1.2', 'No Keyboard Trap', 'A'],
  ['2.1.4', 'Character Key Shortcuts', 'A'],
  ['2.2.1', 'Timing Adjustable', 'A'],
  ['2.2.2', 'Pause, Stop, Hide', 'A'],
  ['2.3.1', 'Three Flashes or Below Threshold', 'A'],
  ['2.4.1', 'Bypass Blocks', 'A'],
  ['2.4.2', 'Page Titled', 'A'],
  ['2.4.3', 'Focus Order', 'A'],
  ['2.4.4', 'Link Purpose (In Context)', 'A'],
  ['2.4.5', 'Multiple Ways', 'AA'],
  ['2.4.6', 'Headings and Labels', 'AA'],
  ['2.4.7', 'Focus Visible', 'AA'],
  ['2.4.11', 'Focus Not Obscured (Minimum)', 'AA'],
  ['2.5.1', 'Pointer Gestures', 'A'],
  ['2.5.2', 'Pointer Cancellation', 'A'],
  ['2.5.3', 'Label in Name', 'A'],
  ['2.5.4', 'Motion Actuation', 'A'],
  ['2.5.7', 'Dragging Movements', 'AA'],
  ['2.5.8', 'Target Size (Minimum)', 'AA'],
  ['3.1.1', 'Language of Page', 'A'],
  ['3.1.2', 'Language of Parts', 'AA'],
  ['3.2.1', 'On Focus', 'A'],
  ['3.2.2', 'On Input', 'A'],
  ['3.2.3', 'Consistent Navigation', 'AA'],
  ['3.2.4', 'Consistent Identification', 'AA'],
  ['3.2.6', 'Consistent Help', 'A'],
  ['3.3.1', 'Error Identification', 'A'],
  ['3.3.2', 'Labels or Instructions', 'A'],
  ['3.3.3', 'Error Suggestion', 'AA'],
  ['3.3.4', 'Error Prevention (Legal, Financial, Data)', 'AA'],
  ['3.3.7', 'Redundant Entry', 'A'],
  ['3.3.8', 'Accessible Authentication (Minimum)', 'AA'],
  ['4.1.2', 'Name, Role, Value', 'A'],
  ['4.1.3', 'Status Messages', 'AA'],
];

const PRINCIPLES: Record<string, Principle> = {
  '1': 'Perceivable',
  '2': 'Operable',
  '3': 'Understandable',
  '4': 'Robust',
};

// The "Understanding" page name, like "contrast-minimum".
function pageName(name: string): string {
  return name.toLowerCase().replace(/[(),]/g, '').replace(/\s+/g, '-');
}

export const CRITERIA: Criterion[] = LIST.map(([number, name, level]) => ({
  number,
  name,
  level,
  principle: PRINCIPLES[number[0] as string] as Principle,
  url: `https://www.w3.org/WAI/WCAG22/Understanding/${pageName(name)}.html`,
}));

// axe writes 1.4.10 as "wcag1410". Only numbers in the list count.
const BY_TAG = new Map(CRITERIA.map((c) => [`wcag${c.number.replaceAll('.', '')}`, c]));

export function criterionByNumber(number: string): Criterion | undefined {
  return CRITERIA.find((c) => c.number === number);
}

// The WCAG criteria in a rule's tags. AAA criteria and unknown tags are skipped.
export function criteriaForTags(tags: string[] = []): Criterion[] {
  const found: Criterion[] = [];
  for (const tag of tags) {
    const criterion = BY_TAG.get(tag);
    if (criterion && !found.includes(criterion)) found.push(criterion);
  }
  return found;
}

// A short label like "WCAG 1.1.1 (A)", or "best practice".
export function criteriaLabel(tags: string[] = []): string {
  const criteria = criteriaForTags(tags);
  if (criteria.length === 0) return tags.includes('best-practice') ? 'best practice' : '';
  return `WCAG ${criteria.map((c) => `${c.number} (${c.level})`).join(', ')}`;
}

export const AREAS = [
  'Images and media',
  'Color and layout',
  'Forms and labels',
  'Keyboard and focus',
  'Names and ARIA',
  'Structure and navigation',
  'Language',
] as const;
export type Area = (typeof AREAS)[number];

const AREA_BY_CATEGORY: Record<string, Area> = {
  'cat.text-alternatives': 'Images and media',
  'cat.time-and-media': 'Images and media',
  'cat.color': 'Color and layout',
  'cat.sensory-and-visual-cues': 'Color and layout',
  'cat.forms': 'Forms and labels',
  'cat.keyboard': 'Keyboard and focus',
  'cat.aria': 'Names and ARIA',
  'cat.name-role-value': 'Names and ARIA',
  'cat.structure': 'Structure and navigation',
  'cat.semantics': 'Structure and navigation',
  'cat.tables': 'Structure and navigation',
  'cat.parsing': 'Structure and navigation',
  'cat.language': 'Language',
};

// The report area for a rule, from its first "cat." tag.
export function areaForTags(tags: string[] = []): Area {
  for (const tag of tags) {
    const area = AREA_BY_CATEGORY[tag];
    if (area) return area;
  }
  return 'Structure and navigation';
}
