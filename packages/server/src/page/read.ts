import type { ElementHandle } from 'puppeteer-core';

export interface ElementState {
  tag: string;
  text: string;
  value?: string;
  visible: boolean;
  enabled: boolean;
  checked?: boolean;
  href?: string;
}

// Reads the state of one element without running any page script of our own.
export async function readElement(handle: ElementHandle<Element>): Promise<ElementState> {
  return handle.evaluate((el) => {
    const html = el as HTMLElement & {
      value?: string;
      checked?: boolean;
      disabled?: boolean;
      type?: string;
      href?: string;
    };
    const text = (html.innerText ?? el.textContent ?? '')
      .replace(/\s+\n/g, '\n')
      .trim()
      .slice(0, 2000);
    const visible =
      typeof html.checkVisibility === 'function'
        ? html.checkVisibility()
        : html.offsetParent !== null;
    const isPassword = html.type === 'password';
    return {
      tag: el.tagName.toLowerCase(),
      text,
      value:
        typeof html.value === 'string'
          ? isPassword && html.value
            ? '(hidden password)'
            : html.value
          : undefined,
      visible,
      enabled: !html.disabled && el.getAttribute('aria-disabled') !== 'true',
      checked:
        html.type === 'checkbox' || html.type === 'radio' ? Boolean(html.checked) : undefined,
      href: typeof html.href === 'string' && html.href ? html.href : undefined,
    };
  });
}

export function formatState(state: ElementState): string {
  const lines = [
    `Element: <${state.tag}>`,
    `Visible: ${state.visible ? 'yes' : 'no'}`,
    `Enabled: ${state.enabled ? 'yes' : 'no'}`,
  ];
  if (state.checked !== undefined) lines.push(`Checked: ${state.checked ? 'yes' : 'no'}`);
  if (state.value !== undefined) lines.push(`Value: "${state.value}"`);
  if (state.href) lines.push(`Link: ${state.href}`);
  lines.push(`Text: ${state.text ? `"${state.text}"` : '(none)'}`);
  return lines.join('\n');
}
