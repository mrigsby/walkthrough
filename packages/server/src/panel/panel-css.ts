// Styles for the in-page panel. They live inside the panel's shadow root,
// so they do not change the app, and the app does not change them.
export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }

.card {
  --bg: #ffffff; --fg: #0f172a; --muted: #475569; --line: #cbd5e1;
  --pass: #15803d; --bug: #b91c1c; --btn: #e2e8f0; --focus: #2563eb;
  position: fixed; z-index: 2147483647; width: 340px; max-width: calc(100vw - 24px);
  background: var(--bg); color: var(--fg); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.25); font-size: 14px; line-height: 1.4;
}
@media (prefers-color-scheme: dark) {
  .card { --bg: #111827; --fg: #f1f5f9; --muted: #94a3b8; --line: #334155; --btn: #1f2937; --focus: #60a5fa; }
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
.icon { background: none; border: none; color: var(--fg); font-size: 16px; width: 26px; height: 26px;
  border-radius: 6px; cursor: pointer; }
.icon:hover { background: var(--btn); }

.body { padding: 10px 12px 12px; }
.card.collapsed .body { display: none; }
.status { margin: 0; color: var(--muted); }
.title { margin: 0 0 8px; font-size: 15px; }
.label { margin: 8px 0 2px; font-size: 11px; font-weight: 700; text-transform: uppercase; color: var(--muted); }
.text { margin: 0; white-space: pre-wrap; }
.notes { width: 100%; margin-top: 10px; padding: 6px 8px; font-size: 13px; color: var(--fg);
  background: var(--bg); border: 1px solid var(--line); border-radius: 6px; resize: vertical; }
.notes:focus { outline: 2px solid var(--focus); outline-offset: 0; }
.error { margin: 4px 0 0; min-height: 1em; color: var(--bug); font-size: 12px; }
.buttons { display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; margin-top: 8px; }
.buttons button { padding: 7px 0; border-radius: 6px; border: 1px solid var(--line); background: var(--btn);
  color: var(--fg); font-size: 13px; font-weight: 600; cursor: pointer; }
.buttons button:focus-visible { outline: 2px solid var(--focus); }
.buttons .pass { background: var(--pass); border-color: var(--pass); color: #ffffff; }
.buttons .bug { background: var(--bug); border-color: var(--bug); color: #ffffff; }

.pulse { position: fixed; z-index: 2147483646; display: none; pointer-events: none;
  border: 3px solid #f59e0b; border-radius: 6px; animation: uiwalk-pulse 0.6s ease-in-out infinite alternate; }
.pulse-label { position: fixed; z-index: 2147483646; display: none; pointer-events: none;
  padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: 600; white-space: nowrap; }
.pulse-label { background: #f59e0b; color: #111827; }
@keyframes uiwalk-pulse { from { box-shadow: 0 0 0 0 rgba(245, 158, 11, 0.6); } to { box-shadow: 0 0 0 8px rgba(245, 158, 11, 0); } }

.annotation { position: absolute; z-index: 2147483646; display: none; pointer-events: none;
  border: 3px solid #dc2626; border-radius: 4px; }
`;
