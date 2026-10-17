// A small part of Markdown for panel text. The server turns text into blocks, and the
// panel builds DOM nodes from them. No raw HTML, no links.
//
// Blocks: paragraphs, "- " or "* " lists, "1." lists, "- [ ]" and "- [x]" check lists,
// and ``` code blocks. Inline: **bold**, *italic*, and `code`.

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'b'; v: string }
  | { t: 'i'; v: string }
  | { t: 'code'; v: string };

export type Block =
  // Lines of one paragraph. The panel puts a line break between them.
  | { t: 'p'; lines: Inline[][] }
  | { t: 'ul'; items: Inline[][] }
  | { t: 'ol'; start: number; items: Inline[][] }
  | { t: 'check'; items: Array<{ text: Inline[]; checked: boolean }> }
  | { t: 'code'; v: string };

// Long text is cut, so one question cannot fill the panel with a huge message.
const MAX_TEXT = 8000;

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|`[^`\n]+`)/g;

export function parseInline(text: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const match of text.matchAll(INLINE)) {
    const at = match.index ?? 0;
    if (at > last) out.push({ t: 'text', v: text.slice(last, at) });
    const token = match[0];
    if (token.startsWith('**')) out.push({ t: 'b', v: token.slice(2, -2) });
    else if (token.startsWith('`')) out.push({ t: 'code', v: token.slice(1, -1) });
    else out.push({ t: 'i', v: token.slice(1, -1) });
    last = at + token.length;
  }
  if (last < text.length) out.push({ t: 'text', v: text.slice(last) });
  return out;
}

const FENCE = /^\s*```\s*([\w+-]*)\s*$/;
const CHECK = /^\s*[-*]\s+\[([ xX])\]\s+(.*)$/;
const BULLET = /^\s*[-*]\s+(.*)$/;
const NUMBER = /^\s*(\d{1,6})[.)]\s+(.*)$/;

export function parseRichText(input: string): Block[] {
  const text = input.replace(/\r\n?/g, '\n').slice(0, MAX_TEXT);
  const blocks: Block[] = [];
  const lines = text.split('\n');
  // The block that the next line can join, or undefined after a blank line.
  let open: Block | undefined;
  // Returns the open block of this kind, or starts a new one.
  const block = <K extends Block['t']>(
    kind: K,
    make: () => Extract<Block, { t: K }>,
  ): Extract<Block, { t: K }> => {
    if (open?.t !== kind) {
      open = make();
      blocks.push(open);
    }
    return open as Extract<Block, { t: K }>;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (FENCE.test(line)) {
      // A code block runs to the next fence, or to the end of the text.
      const code: string[] = [];
      for (i += 1; i < lines.length && !FENCE.test(lines[i] as string); i++) {
        code.push(lines[i] as string);
      }
      blocks.push({ t: 'code', v: code.join('\n') });
      open = undefined;
      continue;
    }
    if (!line.trim()) {
      open = undefined;
      continue;
    }
    const check = CHECK.exec(line);
    if (check) {
      block('check', () => ({ t: 'check', items: [] })).items.push({
        text: parseInline(check[2] as string),
        checked: check[1] !== ' ',
      });
      continue;
    }
    const bullet = BULLET.exec(line);
    if (bullet) {
      block('ul', () => ({ t: 'ul', items: [] })).items.push(parseInline(bullet[1] as string));
      continue;
    }
    const number = NUMBER.exec(line);
    if (number) {
      block('ol', () => ({ t: 'ol', start: Number(number[1]), items: [] })).items.push(
        parseInline(number[2] as string),
      );
      continue;
    }
    block('p', () => ({ t: 'p', lines: [] })).lines.push(parseInline(line.trim()));
  }
  return blocks;
}

// The blocks as plain text, for chat when the panel is not available.
export function blocksText(blocks: Block[]): string {
  const inline = (parts: Inline[]) =>
    parts.map((p) => (p.t === 'code' ? `\`${p.v}\`` : p.v)).join('');
  return blocks
    .map((block) => {
      switch (block.t) {
        case 'p':
          return block.lines.map(inline).join('\n');
        case 'ul':
          return block.items.map((item) => `- ${inline(item)}`).join('\n');
        case 'ol':
          return block.items.map((item, i) => `${block.start + i}. ${inline(item)}`).join('\n');
        case 'check':
          return block.items
            .map((item) => `- [${item.checked ? 'x' : ' '}] ${inline(item.text)}`)
            .join('\n');
        default:
          return `\`\`\`\n${block.v}\n\`\`\``;
      }
    })
    .join('\n\n');
}
