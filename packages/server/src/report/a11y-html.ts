import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { IMPACT_ORDER } from '../audit/axe.js';
import type { Finding } from '../audit/findings.js';
import type { Band } from '../audit/score.js';
import type { A11yReportData } from './a11y-data.js';
import { esc, safeHref } from './common.js';

const IMPACT_LABEL: Record<string, string> = {
  critical: 'Critical',
  serious: 'Serious',
  moderate: 'Moderate',
  minor: 'Minor',
};

const END_LABEL: Record<string, string> = {
  wrapped: 'Focus went back to the first element.',
  'left-page': 'Focus left the page after the last element.',
  trap: 'Focus got stuck in a keyboard trap.',
  limit: 'Walkthrough stopped at 80 Tab stops.',
};

const STATUS_LABEL = {
  problems: 'Problems found',
  passed: 'No problems found by automated checks',
  manual: 'Needs manual check',
};

// Plain text from the agent, with `code` in backticks shown as code.
function prose(text: string): string {
  return esc(text).replace(/`([^`]+)`/g, '<code>$1</code>');
}

function bandClass(score: number | null): string {
  if (score === null) return 'none';
  return score >= 90 ? 'good' : score >= 50 ? 'fair' : 'poor';
}

// A round score meter. The number is text, so it does not depend on color.
function ring(score: number | null, band: Band | null): string {
  const r = 52;
  const length = 2 * Math.PI * r;
  const filled = score === null ? 0 : (length * score) / 100;
  return `<div class="ring ${bandClass(score)}">
<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false">
<circle class="track" cx="60" cy="60" r="${r}"></circle>
<circle class="fill" cx="60" cy="60" r="${r}" stroke-dasharray="${filled.toFixed(1)} ${length.toFixed(1)}" transform="rotate(-90 60 60)"></circle>
</svg>
<div class="ring-text"><span class="ring-score">${score ?? 'n/a'}</span><span class="ring-band">${esc(band ?? 'No score')}</span></div>
</div>`;
}

function bar(label: string, score: number | null, note = ''): string {
  const width = score ?? 0;
  return `<div class="bar-row">
<span class="bar-label">${esc(label)}</span>
<span class="bar-track" aria-hidden="true"><span class="bar-fill ${bandClass(score)}" style="width:${width}%"></span></span>
<span class="bar-value">${score === null ? 'n/a' : score}${note ? ` <span class="muted">${esc(note)}</span>` : ''}</span>
</div>`;
}

function tile(value: string | number, label: string, cls = ''): string {
  return `<div class="tile ${cls}"><span class="tile-value">${esc(String(value))}</span><span class="tile-label">${esc(label)}</span></div>`;
}

function copyButton(text: string, label: string): string {
  return `<button type="button" class="copy" data-copy="${esc(text)}" aria-label="${esc(label)}">Copy</button>`;
}

function level(f: Finding): string {
  if (f.criteria.some((c) => c.level === 'A')) return 'A';
  if (f.criteria.some((c) => c.level === 'AA')) return 'AA';
  return 'best-practice';
}

function shotImage(data: A11yReportData, file: string | undefined, alt: string): string {
  if (!file) return '';
  try {
    const jpg = readFileSync(join(data.runDir, file)).toString('base64');
    return `<figure class="shot"><img src="data:image/jpeg;base64,${jpg}" alt="${esc(alt)}"><figcaption>The first element with this problem, in a red box.</figcaption></figure>`;
  } catch {
    return '';
  }
}

function elementRows(f: Finding): string {
  return f.elements
    .map((e) => {
      const notes: string[] = [];
      if (e.contrast)
        notes.push(
          `Contrast ${e.contrast.ratio}:1, needs ${e.contrast.expected}:1 (text ${e.contrast.fg} on ${e.contrast.bg}).`,
        );
      if (e.failureSummary) notes.push(e.failureSummary);
      const frame = e.frame
        ? `<div class="muted">In frame <code>${esc(e.frame.selector)}</code></div>`
        : '';
      const deep = e.target.includes('>>>')
        ? '<div class="muted">This selector works in Puppeteer. It does not work in the DevTools console.</div>'
        : '';
      return `<tr>
<td><a href="${safeHref(e.url)}">${esc(e.page)}</a></td>
<td><code class="sel">${esc(e.target)}</code> ${copyButton(e.target, `Copy selector ${e.target}`)}${frame}${deep}</td>
<td><pre tabindex="0"><code>${esc(e.html)}</code></pre></td>
<td>${notes.map((n) => `<p>${esc(n)}</p>`).join('')}</td>
</tr>`;
    })
    .join('\n');
}

function issueCard(data: A11yReportData, f: Finding): string {
  const item = data.items[f.id];
  const status = data.status[f.rule];
  const fixedCount = data.elementsFixed[f.rule];
  const lvl = level(f);
  const wcag = f.criteria.length
    ? f.criteria
        .map(
          (c) =>
            `<a class="badge wcag" href="${safeHref(c.url)}">WCAG ${esc(c.number)} ${esc(c.name)} (${c.level})</a>`,
        )
        .join(' ')
    : '<span class="badge wcag">Best practice</span>';
  const search = [f.id, f.rule, f.help, f.area, ...f.elements.map((e) => e.target)]
    .join(' ')
    .toLowerCase();
  const codeId = `code-${f.id}`;
  const parts = [
    `<article class="issue impact-${f.impact}" id="${esc(f.id)}" data-impact="${f.impact}" data-area="${esc(f.area)}" data-pages="|${esc(f.pages.join('|'))}|" data-level="${lvl}" data-status="${status ?? 'new'}" data-text="${esc(search)}">`,
    '<header class="issue-head">',
    `<h3><span class="issue-id">${esc(f.id)}</span> ${esc(f.help)}</h3>`,
    '<div class="badges">',
    `<span class="badge impact ${f.impact}">${IMPACT_LABEL[f.impact]}</span>`,
    wcag,
    `<span class="badge area">${esc(f.area)}</span>`,
    status === 'still'
      ? `<span class="badge still">Still there${fixedCount ? `, ${fixedCount} element(s) fixed` : ''}</span>`
      : data.previous
        ? '<span class="badge new">New</span>'
        : '',
    '</div>',
    `<p class="muted">${f.elementCount} element(s) on ${f.pages.length} page(s): ${f.pages.map((p) => esc(p)).join(', ')}. Rule: <code>${esc(f.rule)}</code>.</p>`,
    '</header>',
    '<div class="issue-body">',
    `<div class="explain"><h4>What is wrong</h4><p>${prose(item?.explain ?? f.description ?? f.help)}</p></div>`,
    `<div class="fix"><h4>How to fix it</h4><p>${prose(item?.fix ?? 'See the rule page for how to fix it.')}</p></div>`,
  ];
  if (item?.fallback)
    parts.push(
      '<p class="muted">This text comes from axe-core. The agent did not write text for this issue.</p>',
    );
  if (item?.code) {
    parts.push(
      `<div class="code"><div class="code-head"><h4>Example</h4><button type="button" class="copy" data-copy-from="${codeId}" aria-label="Copy the example for ${esc(f.id)}">Copy</button></div><pre tabindex="0"><code id="${codeId}">${esc(item.code)}</code></pre></div>`,
    );
  }
  if (item?.where?.length) {
    parts.push(
      `<div class="where"><h4>Where to fix</h4><ul>${item.where
        .map((w) => {
          const place = `${w.file}${w.line ? `:${w.line}` : ''}`;
          return `<li><code>${esc(place)}</code> ${copyButton(place, `Copy ${place}`)}</li>`;
        })
        .join('')}</ul></div>`,
    );
  }
  parts.push(shotImage(data, data.shots[f.rule], `${f.id}: ${f.help}`));
  parts.push(
    `<details class="elements"><summary>Elements (${f.elementCount}${f.elementCount > f.elements.length ? `, first ${f.elements.length} shown` : ''})</summary>
<div class="table-wrap" tabindex="0"><table>
<caption class="sr-only">Elements with the problem ${esc(f.id)}</caption>
<thead><tr><th scope="col">Page</th><th scope="col">Selector</th><th scope="col">HTML</th><th scope="col">Notes</th></tr></thead>
<tbody>${elementRows(f)}</tbody>
</table></div></details>`,
  );
  parts.push(
    `<footer class="issue-foot"><span><a href="${safeHref(f.helpUrl)}">About this rule</a></span>
<label class="fixed-label"><input type="checkbox" class="fixed-box" data-id="${esc(f.id)}"> I fixed this</label></footer>`,
    '</div>',
    '</article>',
  );
  return parts.filter(Boolean).join('\n');
}

function scoresSection(data: A11yReportData): string {
  const s = data.scores;
  const c = s.counts;
  const change = data.previous
    ? `<p class="change">Compared with the report from ${esc(new Date(data.previous.at).toLocaleString('en-US'))}: <strong>${Object.values(data.status).filter((v) => v === 'new').length} new</strong>, <strong>${Object.values(data.status).filter((v) => v === 'still').length} still there</strong>, <strong>${data.fixed.length} fixed</strong>.</p>`
    : '';
  return `<section id="scores" aria-labelledby="scores-title">
<h2 id="scores-title">Scores</h2>
${s.available ? '' : '<p class="note">Score not available: Walkthrough checked this run before it saved the rules that passed.</p>'}
<div class="score-grid">
<div class="card score-main">
${ring(s.overall, s.band)}
<div>
<p class="score-title">Overall ${esc(data.standard)} score</p>
<p class="muted">Best practices: ${s.bestPractices ?? 'n/a'}. ${c.rulesPassed} rule check(s) passed, ${c.rulesFailed} failed.</p>
<p class="muted"><a href="#how">How we scored</a></p>
</div>
</div>
<div class="tiles">
${tile(c.critical, 'Critical', 'critical')}
${tile(c.serious, 'Serious', 'serious')}
${tile(c.moderate, 'Moderate', 'moderate')}
${tile(c.minor, 'Minor', 'minor')}
${tile(c.elements, 'Elements')}
${tile(data.pages.length, 'Pages')}
${tile(c.levelA, 'Level A issues')}
${tile(c.levelAA, 'Level AA issues')}
${tile(c.review, 'Need review')}
</div>
</div>
${change}
<div class="two">
<div class="card"><h3>Areas</h3>${s.areas.map((a) => bar(a.area, a.score, a.total ? `${a.failed} of ${a.total} failed` : 'not checked')).join('')}</div>
<div class="card"><h3>WCAG principles</h3>${s.principles.map((p) => bar(p.principle, p.score)).join('')}</div>
</div>
<div class="card"><h3>Pages</h3>
<div class="table-wrap" tabindex="0"><table>
<caption class="sr-only">Score for each page</caption>
<thead><tr><th scope="col">Page</th><th scope="col">Score</th><th scope="col">Problem types</th></tr></thead>
<tbody>${s.pages.map((p) => `<tr><td><a href="${safeHref(p.url)}">${esc(p.page)}</a></td><td><span class="pill ${bandClass(p.score)}">${p.score ?? 'n/a'}</span></td><td>${p.problems}</td></tr>`).join('')}</tbody>
</table></div></div>
</section>`;
}

function filters(data: A11yReportData): string {
  const areas = [...new Set(data.findings.map((f) => f.area))];
  const option = (value: string, label: string) =>
    `<option value="${esc(value)}">${esc(label)}</option>`;
  return `<div class="filters" role="search" aria-label="Filter the issues">
<fieldset class="impacts"><legend>Impact</legend>
${IMPACT_ORDER.map((i) => `<label><input type="checkbox" name="impact" value="${i}" checked> ${IMPACT_LABEL[i]}</label>`).join('')}
</fieldset>
<label>Area <select name="area"><option value="">All</option>${areas.map((a) => option(a, a)).join('')}</select></label>
<label>Page <select name="page"><option value="">All</option>${data.pages.map((p) => option(p.page, p.page)).join('')}</select></label>
<label>Level <select name="level"><option value="">All</option>${option('A', 'WCAG A')}${option('AA', 'WCAG AA')}${option('best-practice', 'Best practice')}</select></label>
${data.previous ? `<label>Status <select name="status"><option value="">All</option>${option('new', 'New')}${option('still', 'Still there')}</select></label>` : ''}
<label class="search">Search <input type="search" name="q" placeholder="ID, rule, or selector"></label>
<label><input type="checkbox" name="hideFixed"> Hide fixed</label>
<p class="shown" role="status" aria-live="polite"></p>
</div>`;
}

function keyboardSection(data: A11yReportData): string {
  if (!data.keyboard.length) return '';
  return `<section id="keyboard" aria-labelledby="keyboard-title">
<h2 id="keyboard-title">Keyboard</h2>
<p>Walkthrough pressed Tab through each page, like a person who uses a keyboard. Problems it found are in the issues above.</p>
${data.keyboard
  .map(
    (
      k,
    ) => `<details class="card"><summary>${esc(k.page)}: ${k.stops.length} Tab stop(s). ${esc(END_LABEL[k.endedBy] ?? '')}</summary>
<ol class="stops">${k.stops.map((s) => `<li><span class="muted">${esc(s.role)}</span> ${s.name ? `"${esc(s.name)}" ` : ''}<code>${esc(s.target)}</code>${s.frame ? ' <span class="muted">(in a frame)</span>' : ''}</li>`).join('')}</ol>
</details>`,
  )
  .join('\n')}
</section>`;
}

function reviewSection(data: A11yReportData): string {
  if (!data.review.length) return '';
  return `<section id="review" aria-labelledby="review-title">
<h2 id="review-title">Needs manual review</h2>
<p>axe-core could not decide these. A person should check them.</p>
<ul class="review">${data.review
    .map(
      (r) =>
        `<li><a href="${safeHref(r.helpUrl)}"><code>${esc(r.rule)}</code></a>: ${esc(r.help)}. ${r.elementCount} element(s) on ${r.pages.map(esc).join(', ')}.</li>`,
    )
    .join('')}</ul>
</section>`;
}

function fixedSection(data: A11yReportData): string {
  if (!data.previous) return '';
  return `<section id="fixed" aria-labelledby="fixed-title">
<h2 id="fixed-title">Fixed since the last report</h2>
${
  data.fixed.length
    ? `<ul class="fixed-list">${data.fixed.map((f) => `<li><span class="badge fixed">Fixed</span> <strong>${esc(f.id)}</strong> ${esc(f.help)} <span class="muted">(${esc(f.rule)}, ${esc(f.pages.join(', '))})</span></li>`).join('')}</ul>`
    : '<p>The issues from the last report are all still there.</p>'
}
</section>`;
}

function wcagSection(data: A11yReportData): string {
  return `<section id="wcag" aria-labelledby="wcag-title">
<h2 id="wcag-title">WCAG 2.2 criteria</h2>
<p>Automated checks cover part of WCAG. "No problems found by automated checks" does not mean the page meets the criterion. A person must still check it.</p>
<div class="table-wrap" tabindex="0"><table class="wcag-table">
<caption class="sr-only">WCAG 2.2 level A and AA criteria</caption>
<thead><tr><th scope="col">Criterion</th><th scope="col">Level</th><th scope="col">Result</th></tr></thead>
<tbody>${data.wcag
    .map(
      (w) =>
        `<tr><td><a href="${safeHref(w.criterion.url)}">${esc(w.criterion.number)} ${esc(w.criterion.name)}</a></td><td>${w.criterion.level}</td><td><span class="result ${w.status}">${STATUS_LABEL[w.status]}</span>${w.ids.length ? ` ${w.ids.map((id) => `<a href="#${esc(id)}">${esc(id)}</a>`).join(', ')}` : ''}</td></tr>`,
    )
    .join('')}</tbody>
</table></div>
</section>`;
}

function howSection(data: A11yReportData): string {
  return `<section id="how" aria-labelledby="how-title">
<h2 id="how-title">How we checked</h2>
<div class="card"><dl class="facts">
<dt>Standard</dt><dd>${esc(data.standard)}, plus best practices</dd>
<dt>Tools</dt><dd>${esc(data.engine)}, and Walkthrough checks: ${esc(data.checksRun.join(', ') || 'none')}</dd>
<dt>Screen</dt><dd>${esc(data.viewports.join(', ') || 'window size')}</dd>
<dt>Color scheme</dt><dd>${esc(data.colorSchemes.join(', ') || 'system')}</dd>
<dt>Checked</dt><dd>${esc(new Date(data.createdAt).toLocaleString('en-US'))}</dd>
</dl></div>
<h3>How we scored</h3>
<p>Each rule that applies to a page passes or fails. Each rule counts by its impact: critical 10, serious 7, moderate 3, minor 1. The score is the part of that weight that passed, from 0 to 100. The overall score uses WCAG rules only. Best practices have their own score. 90 to 100 is Good, 50 to 89 is Needs work, and below 50 is Poor. Lighthouse uses a similar method.</p>
<h3>Limits</h3>
<ul>
<li>Automated checks find about a third of accessibility problems. Test with a keyboard and a screen reader too.</li>
<li>The dark mode check uses the prefers-color-scheme setting only. Walkthrough does not check a theme switch in the app.</li>
<li>Screenshots can show secrets that appear as normal text on a page.</li>
${data.framesNotChecked.map((f) => `<li>Frame not checked: ${esc(f.url)}. ${esc(f.reason)}</li>`).join('')}
</ul>
</section>`;
}

const CSS = `
:root { color-scheme: light dark; --bg: #f8fafc; --surface: #ffffff; --fg: #0f172a; --muted: #475569; --line: #e2e8f0;
  --link: #1d4ed8; --code: #f1f5f9; --focus: #2563eb;
  --critical: #7f1d1d; --serious: #b91c1c; --moderate: #a16207; --minor: #475569;
  --good: #15803d; --fair: #a16207; --poor: #b91c1c; --new: #1d4ed8; --still: #475569; }
@media (prefers-color-scheme: dark) { :root { --bg: #0b1120; --surface: #111827; --fg: #e5e7eb; --muted: #9ca3af;
  --line: #273244; --link: #93c5fd; --code: #0b1222; --focus: #93c5fd; --good: #22c55e; --fair: #eab308; --poor: #f87171; } }
* { box-sizing: border-box; }
html { scroll-behavior: smooth; scroll-padding-top: 16px; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
a { color: var(--link); text-decoration: underline; }
:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
code, pre { font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
code { background: var(--code); padding: 1px 4px; border-radius: 4px; overflow-wrap: anywhere; }
pre { margin: 0; padding: 10px; background: var(--code); border: 1px solid var(--line); border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; padding: 0; }
.muted { color: var(--muted); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.skip { position: absolute; left: 8px; top: -40px; background: var(--surface); padding: 8px 12px; border-radius: 6px; z-index: 10; }
.skip:focus { top: 8px; }
.top { background: var(--surface); border-bottom: 1px solid var(--line); padding: 20px 24px; }
.top h1 { margin: 0 0 4px; font-size: 24px; }
.top p { margin: 0; }
.layout { display: grid; grid-template-columns: 230px minmax(0, 1fr); gap: 32px; max-width: 1240px; margin: 0 auto; padding: 24px; }
.side { position: sticky; top: 16px; align-self: start; }
.side ul { list-style: none; margin: 0; padding: 0; }
.side li a { display: block; padding: 6px 10px; border-radius: 6px; text-decoration: none; color: var(--fg); }
.side li a:hover { background: var(--code); }
.side .progress { margin-top: 16px; font-size: 13px; }
main { min-width: 0; overflow-wrap: break-word; }
section { margin-bottom: 40px; }
h2 { font-size: 20px; margin: 0 0 12px; }
h3 { font-size: 16px; margin: 0 0 10px; }
h4 { font-size: 13px; text-transform: uppercase; letter-spacing: .04em; color: var(--muted); margin: 0 0 4px; }
.card { background: var(--surface); border: 1px solid var(--line); border-radius: 10px; padding: 16px; margin-bottom: 16px; }
.score-grid { display: grid; grid-template-columns: minmax(260px, 1fr) 2fr; gap: 16px; }
.score-main { display: flex; gap: 20px; align-items: center; }
.score-title { font-size: 17px; font-weight: 600; margin: 0 0 4px; }
.ring { position: relative; width: 120px; height: 120px; flex: none; }
.ring svg { width: 120px; height: 120px; }
.ring .track { fill: none; stroke: var(--line); stroke-width: 12; }
.ring .fill { fill: none; stroke-width: 12; stroke-linecap: round; }
.ring.good .fill { stroke: var(--good); } .ring.fair .fill { stroke: var(--fair); } .ring.poor .fill { stroke: var(--poor); }
.ring-text { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
.ring-score { font-size: 32px; font-weight: 700; line-height: 1; }
.ring-band { font-size: 12px; color: var(--muted); margin-top: 4px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fill, minmax(110px, 1fr)); grid-auto-rows: min-content; align-content: start; gap: 10px; }
.tile { background: var(--surface); border: 1px solid var(--line); border-left: 4px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.tile.critical { border-left-color: var(--critical); } .tile.serious { border-left-color: var(--serious); }
.tile.moderate { border-left-color: var(--moderate); } .tile.minor { border-left-color: var(--minor); }
.tile-value { display: block; font-size: 22px; font-weight: 700; }
.tile-label { font-size: 12px; color: var(--muted); }
.two { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }
.bar-row { display: grid; grid-template-columns: 170px 1fr 140px; gap: 10px; align-items: center; margin: 6px 0; font-size: 14px; }
.bar-track { height: 10px; background: var(--line); border-radius: 999px; overflow: hidden; }
.bar-fill { display: block; height: 100%; border-radius: 999px; }
.bar-fill.good { background: var(--good); } .bar-fill.fair { background: var(--fair); } .bar-fill.poor { background: var(--poor); }
.bar-value { font-variant-numeric: tabular-nums; white-space: nowrap; }
.pill { display: inline-block; min-width: 38px; text-align: center; padding: 1px 8px; border-radius: 999px; font-weight: 600; border: 2px solid var(--line); }
.pill.good { border-color: var(--good); } .pill.fair { border-color: var(--fair); } .pill.poor { border-color: var(--poor); }
.change { background: var(--surface); border: 1px solid var(--line); border-radius: 8px; padding: 10px 14px; }
.note { background: var(--surface); border-left: 4px solid var(--fair); padding: 10px 14px; }
.summary p { font-size: 16px; max-width: 75ch; }
.filters { display: none; position: sticky; top: 0; z-index: 5; flex-wrap: wrap; gap: 10px 16px; align-items: end; background: var(--bg); padding: 12px 0; border-bottom: 1px solid var(--line); margin-bottom: 16px; }
.js .filters { display: flex; }
.filters fieldset { border: 0; padding: 0; margin: 0; display: flex; flex-wrap: wrap; gap: 10px; align-items: center; }
.filters legend { float: left; margin-right: 6px; font-weight: 600; }
.filters label { display: inline-flex; gap: 6px; align-items: center; font-size: 14px; }
.filters select, .filters input[type=search] { font: inherit; padding: 5px 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--fg); }
.filters .shown { margin: 0; font-size: 13px; color: var(--muted); width: 100%; }
.issue { background: var(--surface); border: 1px solid var(--line); border-left: 6px solid var(--line); border-radius: 10px; margin-bottom: 16px; }
.issue.impact-critical { border-left-color: var(--critical); } .issue.impact-serious { border-left-color: var(--serious); }
.issue.impact-moderate { border-left-color: var(--moderate); } .issue.impact-minor { border-left-color: var(--minor); }
.issue.is-fixed { opacity: .65; }
.issue-head { padding: 14px 16px 0; }
.issue-head h3 { font-size: 17px; margin-bottom: 8px; }
.issue-id { font-family: ui-monospace, Menlo, monospace; color: var(--muted); font-size: 14px; margin-right: 4px; }
.badges { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 8px; }
.badge { display: inline-block; padding: 2px 9px; border-radius: 999px; font-size: 12px; font-weight: 600; border: 1px solid var(--line); color: var(--fg); background: var(--surface); text-decoration: none; }
.badge.impact { color: #ffffff; border: 0; }
.badge.impact.critical { background: var(--critical); } .badge.impact.serious { background: var(--serious); }
.badge.impact.moderate { background: var(--moderate); } .badge.impact.minor { background: var(--minor); }
.badge.new { background: var(--new); color: #ffffff; border: 0; } .badge.still { background: var(--still); color: #ffffff; border: 0; }
.badge.fixed { background: #15803d; color: #ffffff; border: 0; }
a.badge.wcag { text-decoration: underline; }
.issue-body { padding: 4px 16px 14px; display: grid; grid-template-columns: minmax(0, 1fr); gap: 12px; }
.issue-body > *, .score-grid > *, .two > * { min-width: 0; }
.issue-body p { margin: 0; }
.explain, .fix { max-width: 80ch; }
.code-head { display: flex; justify-content: space-between; align-items: center; }
.where ul { margin: 0; padding-left: 18px; }
.shot { margin: 0; }
.shot img { max-width: 100%; max-height: 260px; border: 1px solid var(--line); border-radius: 6px; }
.shot figcaption { font-size: 12px; color: var(--muted); }
details summary { cursor: pointer; font-weight: 600; }
.elements .table-wrap { margin-top: 8px; }
.table-wrap { overflow-x: auto; }
table { width: 100%; border-collapse: collapse; font-size: 14px; }
th, td { text-align: left; padding: 8px; border-bottom: 1px solid var(--line); vertical-align: top; }
td p { margin: 0 0 4px; }
.elements td pre { max-width: 420px; }
.issue-foot { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--line); padding-top: 10px; }
.fixed-label { display: inline-flex; gap: 6px; align-items: center; font-weight: 600; }
.copy { font: 12px system-ui, sans-serif; padding: 2px 8px; border: 1px solid var(--line); border-radius: 5px; background: var(--surface); color: var(--fg); cursor: pointer; }
.copy.done { border-color: var(--good); }
.stops { columns: 2; font-size: 14px; }
.result.problems { color: var(--serious); font-weight: 600; }
@media (prefers-color-scheme: dark) { .result.problems { color: #fca5a5; } }
.result.manual { color: var(--muted); }
.facts { display: grid; grid-template-columns: max-content 1fr; gap: 6px 16px; margin: 0; }
.facts dt { color: var(--muted); } .facts dd { margin: 0; }
.prompt pre { font-size: 14px; }
.foot { max-width: 1240px; margin: 0 auto; padding: 0 24px 32px; color: var(--muted); font-size: 13px; }
@media (max-width: 900px) {
  .layout { grid-template-columns: 1fr; padding: 16px; gap: 16px; }
  .side { position: static; } .side ul { display: flex; flex-wrap: wrap; gap: 4px; }
  .score-grid, .two { grid-template-columns: 1fr; }
  .bar-row { grid-template-columns: 110px 1fr; }
  .bar-value { grid-column: 2; }
  .score-main { flex-direction: column; align-items: flex-start; }
  .stops { columns: 1; }
}
@media print {
  .side, .filters, .copy, .skip { display: none !important; }
  .layout { display: block; padding: 0; }
  .issue, .card { break-inside: avoid; }
  details { display: block; } details > summary { list-style: none; }
  body { background: #ffffff; color: #000000; }
}
`;

// Filters, copy buttons, and the fixed checklist. The page works without it.
const SCRIPT = `
(() => {
  document.documentElement.classList.add('js');
  const key = 'uiwalk-a11y:' + document.body.dataset.run;
  let marked = {};
  try { marked = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (e) { marked = {}; }
  const save = () => { try { localStorage.setItem(key, JSON.stringify(marked)); } catch (e) {} };
  const issues = [...document.querySelectorAll('.issue')];
  const boxes = [...document.querySelectorAll('.fixed-box')];
  const form = document.querySelector('.filters');
  const shown = document.querySelector('.filters .shown');
  const progress = () => {
    const n = boxes.filter((b) => b.checked).length;
    document.querySelectorAll('[data-progress]').forEach((el) => { el.textContent = n + ' of ' + boxes.length + ' marked fixed'; });
  };
  const apply = () => {
    if (!form) return;
    const impacts = new Set([...form.querySelectorAll('input[name=impact]:checked')].map((i) => i.value));
    const val = (name) => (form.querySelector('[name=' + name + ']') || {}).value || '';
    const q = val('q').trim().toLowerCase();
    const hide = form.querySelector('[name=hideFixed]').checked;
    let count = 0;
    for (const el of issues) {
      const d = el.dataset;
      const ok = impacts.has(d.impact) && (!val('area') || d.area === val('area')) &&
        (!val('page') || d.pages.includes('|' + val('page') + '|')) && (!val('level') || d.level === val('level')) &&
        (!val('status') || d.status === val('status')) && (!q || d.text.includes(q)) &&
        !(hide && el.classList.contains('is-fixed'));
      el.hidden = !ok;
      if (ok) count += 1;
    }
    if (shown) shown.textContent = 'Showing ' + count + ' of ' + issues.length + ' issues.';
  };
  for (const box of boxes) {
    box.checked = Boolean(marked[box.dataset.id]);
    box.closest('.issue').classList.toggle('is-fixed', box.checked);
    box.addEventListener('change', () => {
      marked[box.dataset.id] = box.checked;
      box.closest('.issue').classList.toggle('is-fixed', box.checked);
      save(); progress(); apply();
    });
  }
  if (form) { form.addEventListener('input', apply); form.addEventListener('change', apply); }
  document.addEventListener('click', (event) => {
    const button = event.target.closest('.copy');
    if (!button) return;
    const from = button.dataset.copyFrom ? document.getElementById(button.dataset.copyFrom) : null;
    const text = from ? from.textContent : button.dataset.copy;
    const done = () => { button.textContent = 'Copied'; button.classList.add('done'); setTimeout(() => { button.textContent = 'Copy'; button.classList.remove('done'); }, 1500); };
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(done, () => {});
  });
  progress(); apply();
})();
`;

// One HTML file with everything inside. It opens without a server or a network.
export function a11yHtmlReport(data: A11yReportData): string {
  const nonce = randomBytes(12).toString('base64');
  const byImpact = [...data.findings].sort(
    (a, b) =>
      IMPACT_ORDER.indexOf(a.impact) - IMPACT_ORDER.indexOf(b.impact) || a.id.localeCompare(b.id),
  );
  const nav: Array<[string, string]> = [
    ['scores', 'Scores'],
    ['summary', 'Summary'],
    ['issues', `Issues (${data.findings.length})`],
    ...(data.previous
      ? ([['fixed', `Fixed (${data.fixed.length})`]] as Array<[string, string]>)
      : []),
    ...(data.keyboard.length ? ([['keyboard', 'Keyboard']] as Array<[string, string]>) : []),
    ...(data.review.length
      ? ([['review', `Needs review (${data.review.length})`]] as Array<[string, string]>)
      : []),
    ['wcag', 'WCAG criteria'],
    ['how', 'How we checked'],
    ['next', 'Next step'],
  ];
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'">
<title>Accessibility report: ${esc(data.runName)}</title>
<style>${CSS}</style>
</head>
<body data-run="${esc(data.runId)}">
<a class="skip" href="#main">Skip to the report</a>
<header class="top">
<h1>Accessibility report</h1>
<p class="muted">${esc(data.baseUrl ?? data.runName)}. ${data.pages.length} page(s). ${esc(data.standard)}. ${esc(new Date(data.createdAt).toLocaleString('en-US'))}. <a href="report.html">Run report</a></p>
</header>
<div class="layout">
<nav class="side" aria-label="Report sections">
<ul>${nav.map(([id, label]) => `<li><a href="#${id}">${esc(label)}</a></li>`).join('')}</ul>
<p class="progress muted" data-progress></p>
</nav>
<main id="main">
${scoresSection(data)}
<section id="summary" class="summary" aria-labelledby="summary-title">
<h2 id="summary-title">Summary</h2>
<p>${prose(data.summary || 'No summary.')}</p>
</section>
<section id="issues" aria-labelledby="issues-title">
<h2 id="issues-title">Issues</h2>
${data.findings.length ? filters(data) : ''}
${byImpact.map((f) => issueCard(data, f)).join('\n') || '<p>No accessibility problems found by the automated checks.</p>'}
</section>
${fixedSection(data)}
${keyboardSection(data)}
${reviewSection(data)}
${wcagSection(data)}
${howSection(data)}
<section id="next" class="prompt" aria-labelledby="next-title">
<h2 id="next-title">Next step</h2>
<p>To plan the fixes, paste this prompt into a new Claude Code session. ${copyButton(data.prompt, 'Copy the prompt')}</p>
<pre tabindex="0"><code>${esc(data.prompt)}</code></pre>
</section>
</main>
</div>
<footer class="foot">Run ${esc(data.runId)}. Files: accessibility.html, accessibility.md, accessibility.json.</footer>
<script nonce="${nonce}">${SCRIPT}</script>
</body>
</html>
`;
}
