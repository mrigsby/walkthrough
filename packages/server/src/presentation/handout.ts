import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from '../report/common.js';
import type { PresentationSession } from './session.js';

export interface HandoutStep {
  index: number;
  title: string;
  notes?: string;
  slide: boolean;
  timeBudgetSec?: number;
  spentMs: number;
  // False for a step that the presentation did not reach.
  shown: boolean;
  // A picture of the audience screen after the step, as JPEG.
  frame?: Buffer;
}

export interface HandoutData {
  name: string;
  runId: string;
  environment: { name: string; label: string; color: string; baseUrl?: string };
  startedAt: number;
  endedAt: number;
  timeBudgetSec?: number;
  steps: HandoutStep[];
  chat: Array<{ question?: string; answer?: string }>;
  // The recording, from the handout folder.
  video?: { file: string; seconds: number };
  videoNote?: string;
}

// What the handout needs from a presentation. Chat text and notes lose their secrets.
export function handoutData(
  session: PresentationSession,
  frames: Map<number, Buffer>,
  redact: (text: string) => string,
  endedAt = Date.now(),
): HandoutData {
  return {
    name: session.info.name,
    runId: session.info.runId,
    environment: session.info.environment,
    startedAt: session.startedAt ?? session.openedAt,
    endedAt,
    ...(session.info.timeBudgetSec ? { timeBudgetSec: session.info.timeBudgetSec } : {}),
    steps: session.steps.map((step, i) => {
      const frame = frames.get(i);
      const spentMs = session.stepTimes.get(i) ?? 0;
      return {
        index: step.index,
        title: redact(step.title),
        ...(step.notes ? { notes: redact(step.notes) } : {}),
        slide: Boolean(step.slide),
        ...(step.timeBudgetSec ? { timeBudgetSec: step.timeBudgetSec } : {}),
        spentMs,
        shown: Boolean(frame) || spentMs > 0,
        ...(frame ? { frame } : {}),
      };
    }),
    chat: session.chat
      .filter((c) => c.question || c.answer)
      .map((c) => ({
        ...(c.question ? { question: redact(c.question) } : {}),
        ...(c.answer ? { answer: redact(c.answer) } : {}),
      })),
  };
}

function clock(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function when(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// A folder name for one presentation, like "2026-10-02_141500-staging".
export function handoutFolder(startedAt: number, environment: string): string {
  const d = new Date(startedAt);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${environment}`;
}

function frameFile(index: number): string {
  return `frames/step-${String(index).padStart(2, '0')}.jpg`;
}

function timeText(step: HandoutStep): string {
  return `${clock(step.spentMs)}${step.timeBudgetSec ? ` (budget ${clock(step.timeBudgetSec * 1000)})` : ''}`;
}

// Notes use a small part of Markdown. The text is escaped first, so raw HTML shows as text.
function inlineHtml(text: string): string {
  return esc(text)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '$1 ($2)')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*\w])[*_]([^*_\s][^*_]*)[*_]/g, '$1<em>$2</em>');
}

export function notesHtml(text: string): string {
  const out: string[] = [];
  const item = /^\s*[-*]\s+/;
  for (const block of text.trim().split(/\n\s*\n/)) {
    let list: string[] | undefined;
    let para: string[] | undefined;
    const flush = () => {
      if (list) out.push(`<ul>${list.map((l) => `<li>${l}</li>`).join('')}</ul>`);
      if (para) out.push(`<p>${para.join('<br>')}</p>`);
      list = undefined;
      para = undefined;
    };
    for (const line of block.split('\n')) {
      if (item.test(line)) {
        if (para) flush();
        list ??= [];
        list.push(inlineHtml(line.replace(item, '')));
      } else {
        if (list) flush();
        para ??= [];
        para.push(inlineHtml(line));
      }
    }
    flush();
  }
  return out.join('\n');
}

const CSS = `
body { margin: 0; background: #f8fafc; color: #0f172a; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 960px; margin: 0 auto; padding: 32px 20px 64px; }
h1 { margin: 0 0 8px; }
.meta { color: #475569; margin: 0 0 24px; }
.env { display: inline-block; padding: 1px 10px; border-radius: 999px; color: #fff; font-weight: 600; font-size: 14px; }
.step { background: #fff; border: 1px solid #e2e8f0; border-radius: 12px; padding: 16px 20px; margin: 16px 0; }
.step h2 { margin: 0 0 4px; font-size: 20px; }
.step .time { color: #64748b; font-size: 14px; margin: 0 0 12px; }
.step .over { color: #b91c1c; }
.step img { width: 100%; border: 1px solid #e2e8f0; border-radius: 8px; }
.notes { margin-top: 12px; }
.notes code, .qa code { background: #f1f5f9; padding: 0 4px; border-radius: 4px; }
.skipped { color: #64748b; }
.qa dt { font-weight: 600; margin-top: 12px; }
.qa dd { margin: 4px 0 0 0; }
video { width: 100%; border-radius: 8px; background: #000; }
@media print { body { background: #fff; } .step { break-inside: avoid; } }
`;

function html(data: HandoutData): string {
  const env = data.environment;
  const length = clock(data.endedAt - data.startedAt);
  const shown = data.steps.filter((s) => s.shown).length;
  const steps = data.steps
    .map((step) => {
      const over = step.timeBudgetSec && step.spentMs > step.timeBudgetSec * 1000;
      return [
        `<section class="step${step.shown ? '' : ' skipped'}">`,
        `<h2>${step.index}. ${esc(step.title)}${step.slide ? ' <small>(slide)</small>' : ''}</h2>`,
        step.shown
          ? `<p class="time${over ? ' over' : ''}">Time: ${esc(timeText(step))}</p>`
          : '<p class="time">Not shown.</p>',
        step.frame ? `<img src="${frameFile(step.index)}" alt="Step ${step.index}">` : '',
        step.notes ? `<div class="notes">${notesHtml(step.notes)}</div>` : '',
        '</section>',
      ].join('\n');
    })
    .join('\n');
  const qa = data.chat.length
    ? `<h2>Questions and answers</h2>\n<dl class="qa">${data.chat
        .map(
          (c) =>
            `${c.question ? `<dt>Q: ${esc(c.question)}</dt>` : '<dt>Note</dt>'}<dd>${c.answer ? esc(c.answer) : '<em>No answer.</em>'}</dd>`,
        )
        .join('\n')}</dl>`
    : '';
  const video = data.video
    ? `<h2>Recording</h2>\n<video controls src="${esc(data.video.file)}"></video>\n<p><a href="${esc(data.video.file)}">${esc(data.video.file)}</a> (${clock(data.video.seconds * 1000)})</p>`
    : data.videoNote
      ? `<p>${esc(data.videoNote)}</p>`
      : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(data.name)}: presentation</title><style>${CSS}</style></head>
<body><main>
<h1>${esc(data.name)}</h1>
<p class="meta"><span class="env" style="background:${esc(env.color)}">${esc(env.label)}</span> ${esc(env.baseUrl ?? env.name)}<br>
${esc(when(data.startedAt))}. Length ${length}${data.timeBudgetSec ? ` (budget ${clock(data.timeBudgetSec * 1000)})` : ''}. ${shown} of ${data.steps.length} steps shown. Rehearsal ${esc(data.runId)}.</p>
${steps}
${qa}
${video}
</main></body></html>
`;
}

function markdown(data: HandoutData): string {
  const env = data.environment;
  const lines = [
    `# ${data.name}`,
    '',
    `- Environment: ${env.label} (${env.name})${env.baseUrl ? `, ${env.baseUrl}` : ''}`,
    `- Date: ${when(data.startedAt)}`,
    `- Length: ${clock(data.endedAt - data.startedAt)}${data.timeBudgetSec ? ` (budget ${clock(data.timeBudgetSec * 1000)})` : ''}`,
    `- Steps shown: ${data.steps.filter((s) => s.shown).length} of ${data.steps.length}`,
    `- Rehearsal: ${data.runId}`,
    ...(data.video ? [`- Recording: [${data.video.file}](${data.video.file})`] : []),
    ...(data.videoNote ? [`- Recording: ${data.videoNote}`] : []),
    '',
  ];
  for (const step of data.steps) {
    lines.push(`## ${step.index}. ${step.title}${step.slide ? ' (slide)' : ''}`, '');
    lines.push(step.shown ? `Time: ${timeText(step)}` : 'Not shown.', '');
    if (step.frame) lines.push(`![Step ${step.index}](${frameFile(step.index)})`, '');
    if (step.notes) lines.push(step.notes.trim(), '');
  }
  if (data.chat.length) {
    lines.push('## Questions and answers', '');
    for (const c of data.chat) {
      lines.push(c.question ? `**Q:** ${c.question}` : '**Note**', '');
      lines.push(c.answer ? `**A:** ${c.answer}` : '*No answer.*', '');
    }
  }
  return `${lines.join('\n').trimEnd()}\n`;
}

// Writes presentation.html, presentation.md, and the step pictures into the folder.
export function writeHandout(dir: string, data: HandoutData): { html: string; md: string } {
  mkdirSync(join(dir, 'frames'), { recursive: true });
  for (const step of data.steps) {
    if (step.frame) writeFileSync(join(dir, frameFile(step.index)), step.frame);
  }
  const files = { html: join(dir, 'presentation.html'), md: join(dir, 'presentation.md') };
  writeFileSync(files.html, html(data));
  writeFileSync(files.md, markdown(data));
  return files;
}
