// Styles for the in-page panel. They live inside the panel's shadow root,
// so they do not change the app, and the app does not change them.
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.card, .modal {
  --bg: #ffffff; --fg: #0f172a; --muted: #475569; --line: #cbd5e1;
  --pass: #15803d; --bug: #b91c1c; --btn: #e2e8f0; --focus: #2563eb;
}
.card {
  position: fixed; z-index: 2147483647; width: 340px; max-width: calc(100vw - 24px);
  display: flex; flex-direction: column; max-height: calc(100vh - 24px);
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25); font-size: 14px; line-height: 1.4;
}
@media (prefers-color-scheme: dark) {
  .card, .modal { --bg: #111827; --fg: #f1f5f9; --muted: #94a3b8; --line: #334155; --btn: #1f2937; --focus: #60a5fa; }
}
.card[data-corner="bottom-right"] { right: 12px; bottom: 12px; }
.card[data-corner="bottom-left"] { left: 12px; bottom: 12px; }
.card[data-corner="top-left"] { left: 12px; top: 12px; }
.card[data-corner="top-right"] { right: 12px; top: 12px; }
.card.asking { border: 2px solid var(--focus); }

.header { display: flex; align-items: center; gap: 8px; padding: 8px 10px; cursor: move;
  border-bottom: 1px solid var(--line); user-select: none; }
.card.collapsed .header { border-bottom: none; }
.brand { font-weight: 700; }
.step { color: var(--muted); font-size: 12px; flex: 1; }
.env { padding: 1px 7px; border-radius: 4px; color: #ffffff; font-size: 11px; font-weight: 700; }
.env[hidden] { display: none; }
.buttons.two { grid-template-columns: 1fr 1fr; }
.buttons button[hidden], .question [hidden] { display: none; }
.icon { background: none; border: none; color: var(--fg); font-size: 16px; width: 26px; height: 26px;
  border-radius: 6px; cursor: pointer; }
.icon:hover { background: var(--btn); }

.body { padding: 10px 12px 12px; overflow-y: auto; min-height: 0; }
.card.collapsed .body { display: none; }
.status { margin: 0; color: var(--muted); }
.title { margin: 0 0 8px; font-size: 15px; }
.label { margin: 8px 0 2px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--muted); }
.text { margin: 0; white-space: pre-wrap; }
.section-body > * + * { margin-top: 6px; }
.list { margin: 0; padding-left: 20px; }
.checks { margin: 0; padding-left: 0; list-style: none; }
.checks li { display: flex; gap: 6px; align-items: baseline; }
.checks .check { margin: 0; flex: none; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px;
  background: var(--btn); padding: 1px 4px; border-radius: 4px; }
pre.code { margin: 0; padding: 8px; background: var(--btn); border-radius: 6px; overflow-x: auto; }
pre.code code { padding: 0; background: none; white-space: pre; }
.toggle { display: block; margin: 8px 0 2px; padding: 0; background: none; border: none; cursor: pointer;
  font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--muted); text-align: left; }
.toggle:focus-visible { outline: 2px solid var(--focus); }
.toggle .arrow { display: inline-block; width: 14px; font-size: 14px; line-height: 1; }
.checks .check:not(:disabled) { cursor: pointer; }

.snip { display: inline; }
.snip code { white-space: pre-wrap; overflow-wrap: anywhere; }
.snip button, .copy-button { margin-left: 4px; padding: 1px 6px; border-radius: 4px; border: 1px solid var(--line);
  background: var(--bg); color: var(--fg); font-size: 11px; font-weight: 600; line-height: 1.4; cursor: pointer; vertical-align: 1px; }
.snip .help-snip { padding: 1px 5px; border-radius: 9px; }
.snip button:focus-visible, .copy-button:focus-visible { outline: 2px solid var(--focus); }
.copy-note { margin-left: 6px; font-size: 11px; font-weight: 600; color: var(--pass); }
.code-wrap { position: relative; }
.code-wrap pre.code { padding-right: 56px; }
.code-wrap .copy-button { position: absolute; top: 5px; right: 5px; margin: 0; }
.code-wrap .help-button { position: absolute; top: 5px; right: 56px; padding: 1px 6px; border-radius: 9px;
  border: 1px solid var(--line); background: var(--bg); color: var(--fg); font-size: 11px; font-weight: 600; cursor: pointer; }
.code-wrap:has(.help-button) pre.code { padding-right: 84px; }
.code-wrap .copy-note { position: absolute; right: 5px; top: 30px; margin: 0; }
.copy-area { position: fixed; left: -9999px; top: 0; width: 1px; height: 1px; opacity: 0; }

.ref-image .caption { display: block; margin-top: 2px; font-size: 11px; color: var(--muted); }
.ref-thumb { display: block; max-width: 100%; max-height: 140px; width: auto; height: auto;
  border: 1px solid var(--line); border-radius: 6px; cursor: zoom-in; }

.modal-backdrop, .card-backdrop { position: fixed; inset: 0; z-index: 2147483647; display: flex; align-items: center;
  justify-content: center; padding: 16px; background: rgba(15, 23, 42, 0.55); }
.modal-backdrop[hidden], .card-backdrop[hidden] { display: none; }
.modal { display: flex; flex-direction: column; width: min(720px, 100%); max-height: 88vh;
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.35); font-size: 14px; line-height: 1.5; outline: none; }
.modal-head { display: flex; align-items: center; gap: 8px; padding: 10px 14px; border-bottom: 1px solid var(--line); }
.modal-title { flex: 1; margin: 0; font-size: 16px; }
.modal-body { padding: 12px 14px 16px; overflow-y: auto; min-height: 0; }
.modal-body > * + * { margin-top: 8px; }
.subheading { margin: -4px 0 8px; color: var(--muted); }
.subheading[hidden], .card-note[hidden] { display: none; }
.card-note { color: var(--muted); }
.card-modal .card-title { font-size: 22px; }
.card-modal .modal-head { border-bottom: none; padding: 18px 20px 0; }
.card-modal .modal-body { padding: 4px 20px 20px; font-size: 15px; }
.card-modal .subheading { margin: 0 0 10px; font-size: 15px; }
.progress { margin: 0 0 10px; padding: 0 0 8px; list-style: none; max-height: 180px; overflow-y: auto;
  border-bottom: 1px solid var(--line); font-size: 12px; }
.progress[hidden], .point-row[hidden], .point-clear[hidden], .icon[hidden] { display: none; }
.progress-item { display: flex; gap: 6px; padding: 1px 0; color: var(--muted); }
.progress-item .mark { width: 14px; flex: none; text-align: center; }
.progress-item.current { color: var(--fg); font-weight: 700; }
.progress-item.status-pass .mark { color: var(--pass); }
.progress-item.status-bug .mark, .progress-item.status-fail .mark, .progress-item.status-blocked .mark { color: var(--bug); }
.progress-item .card-name { font-style: italic; }
.point-row { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 12px; }
.point-row .point, .point-row .point-clear { padding: 2px 8px; border-radius: 4px; border: 1px solid var(--line);
  background: var(--btn); color: var(--fg); font-size: 12px; font-weight: 600; cursor: pointer; }
.point-row .point-clear { padding: 2px 6px; }
.point-label { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); }
.point-outline { position: fixed; z-index: 2147483646; pointer-events: none; border: 3px dashed #dc2626;
  border-radius: 4px; background: rgba(220, 38, 38, 0.08); }
.point-outline[hidden], .point-banner[hidden] { display: none; }
.point-banner { position: fixed; z-index: 2147483647; top: 12px; left: 50%; transform: translateX(-50%);
  pointer-events: none; padding: 6px 14px; border-radius: 6px; background: #dc2626; color: #ffffff;
  font-size: 13px; font-weight: 700; box-shadow: 0 4px 14px rgba(0, 0, 0, 0.3); }
.ref-big { display: block; max-width: 100%; max-height: 72vh; width: auto; height: auto; margin: 0 auto; }
.notes { width: 100%; margin-top: 10px; padding: 6px 8px; font-size: 13px; color: var(--fg);
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px; resize: vertical; }
.notes:focus { outline: 2px solid var(--focus); outline-offset: 0; }
.error { margin: 4px 0 0; min-height: 1em; color: var(--bug); font-size: 12px; }
.buttons { display: grid; grid-template-columns: repeat(auto-fit, minmax(56px, 1fr)); gap: 6px; margin-top: 8px; }
.buttons button { padding: 7px 4px; border-radius: 6px; border: 1px solid var(--line); background: var(--btn);
  color: var(--fg); font-size: 13px; font-weight: 600; line-height: 1.2; cursor: pointer; overflow-wrap: anywhere; }
.buttons button:focus-visible { outline: 2px solid var(--focus); }
.buttons .pass { background: var(--pass); border-color: var(--pass); color: #ffffff; }
.buttons .bug { background: var(--bug); border-color: var(--bug); color: #ffffff; }

.pulse { position: fixed; z-index: 2147483646; display: none; pointer-events: none;
  border: 3px solid #f59e0b; border-radius: 6px; animation: uiwalk-pulse 0.6s ease-in-out infinite alternate; }
.pulse-label { position: fixed; z-index: 2147483646; display: none; pointer-events: none;
  padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pulse-label { background: #f59e0b; color: #111827; }
@keyframes uiwalk-pulse { from { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6); } to { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); } }

.card.recording-on { border: 2px solid #dc2626; }
.card.recording-on .step { color: #dc2626; font-weight: 700; }
.recording .text { margin: 0 0 8px; }
.record-buttons { grid-template-columns: 1fr; }
.recording .rec-save { width: 100%; margin: 6px 0; padding: 6px 0; border-radius: 6px; border: 1px solid var(--line);
  background: var(--btn); color: var(--fg); font-weight: 600; cursor: pointer; }
.buttons .rec-stop { background: #dc2626; border-color: #dc2626; color: #ffffff; }

.annotation { position: absolute; z-index: 2147483646; display: none; pointer-events: none;
  border: 3px solid #dc2626; border-radius: 4px; }
`;
