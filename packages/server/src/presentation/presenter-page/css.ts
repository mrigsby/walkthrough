// The look of the presenter window. Dark, so it does not light up a dim room.
export const PRESENTER_CSS = `
:root { color-scheme: dark; --bg: #0b1020; --panel: #131b2f; --line: #26314d; --text: #e5e7eb;
  --muted: #94a3b8; --accent: #3b82f6; --warn: #f59e0b; --bad: #ef4444; --good: #22c55e; }
* { box-sizing: border-box; }
[hidden] { display: none !important; }
html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
body { display: flex; flex-direction: column; overflow: hidden; }
button { font: inherit; color: var(--text); background: #1e293b; border: 1px solid var(--line);
  border-radius: 8px; padding: 8px 14px; cursor: pointer; }
button:hover { background: #26324a; }
button:disabled { opacity: 0.6; cursor: default; }
button.primary { background: var(--accent); border-color: var(--accent); color: #fff; }
button.danger { border-color: #7f1d1d; color: #fecaca; }
button.danger.big, .dialog button.danger { background: #991b1b; color: #fff; }
button.big { font-size: 20px; padding: 14px 28px; }
button.small { padding: 2px 8px; font-size: 13px; }
button.on { background: var(--warn); border-color: var(--warn); color: #111827; }
header { display: flex; justify-content: space-between; align-items: center; gap: 16px;
  padding: 10px 18px; border-bottom: 1px solid var(--line); background: var(--panel); }
header .title { display: flex; align-items: center; gap: 10px; min-width: 0; }
header .name { font-size: 18px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.env { padding: 2px 10px; border-radius: 999px; color: #fff; font-weight: 600; font-size: 13px; }
.url { color: var(--muted); font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.clocks { display: flex; gap: 18px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.clocks .clock { color: var(--muted); }
.near { color: var(--warn); }
.over { color: var(--bad); font-weight: 700; }
main { flex: 1; display: grid; grid-template-columns: minmax(0, 3fr) minmax(320px, 2fr); gap: 16px;
  padding: 16px 18px; min-height: 0; }
.left, .right { display: flex; flex-direction: column; gap: 12px; min-height: 0; }
.now { background: var(--panel); border: 1px solid var(--line); border-radius: 12px; padding: 12px 16px; }
.nowbar { display: flex; justify-content: space-between; align-items: center; }
.now h1 { margin: 6px 0 0; font-size: 26px; line-height: 1.25; }
.chip { font-size: 12px; text-transform: uppercase; letter-spacing: 0.06em; padding: 2px 8px;
  border-radius: 6px; background: #1e293b; }
.chip.gate { background: #1d4ed8; }
.chip.running { background: #15803d; }
.chip.failed { background: var(--bad); }
.chip.manual, .chip.end { background: #7c3aed; }
.steptime { font-variant-numeric: tabular-nums; }
.failure { background: #3f1d1d; border: 1px solid var(--bad); border-radius: 12px; padding: 12px 16px; }
.failure p { margin: 6px 0 10px; white-space: pre-wrap; }
.manual { background: #2e1065; border: 1px solid #7c3aed; border-radius: 12px; padding: 12px 16px; }
.notes { flex: 1; min-height: 0; display: flex; flex-direction: column; background: var(--panel);
  border: 1px solid var(--line); border-radius: 12px; }
.notesbar { display: flex; align-items: center; gap: 6px; padding: 8px 12px; border-bottom: 1px solid var(--line);
  color: var(--muted); }
.notesbar span { flex: 1; }
.notes-text { flex: 1; overflow: auto; padding: 8px 16px; }
.notes-text p { margin: 0 0 0.6em; }
.notes-text ul { margin: 0 0 0.6em; padding-left: 1.2em; }
.notes-text code { background: #1e293b; padding: 0 4px; border-radius: 4px; }
.muted { color: var(--muted); }
.next { color: var(--muted); font-size: 16px; }
.controls { display: flex; flex-direction: column; gap: 8px; }
.row, .primary-row { display: flex; flex-wrap: wrap; gap: 8px; }
.mirror { background: #000; border: 1px solid var(--line); border-radius: 12px; overflow: hidden;
  aspect-ratio: 16 / 10; flex: none; }
.mirror img { width: 100%; height: 100%; object-fit: contain; display: block; }
.jumpbar:empty { display: none; }
.jumpbar { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; background: #172554;
  border: 1px solid var(--accent); border-radius: 10px; padding: 8px 12px; }
.jumpbar span { flex: 1 1 200px; }
.steps { list-style: none; margin: 0; padding: 0; overflow: auto; max-height: 30vh; flex: none;
  background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.steps li { display: flex; gap: 10px; padding: 6px 12px; border-bottom: 1px solid var(--line); }
.steps li:last-child { border-bottom: 0; }
.steps li.can-jump { cursor: pointer; }
.steps li.can-jump:hover { background: #1e293b; }
.steps li.here { background: #172554; }
.steps li.done .label { color: var(--muted); }
.steps .mark { width: 1.6em; text-align: center; color: var(--muted); }
.steps li.done .mark { color: var(--good); }
.steps .label { flex: 1; }
.steps .spent { color: var(--muted); font-variant-numeric: tabular-nums; }
.chat { flex: 1; min-height: 160px; display: flex; flex-direction: column; background: var(--panel);
  border: 1px solid var(--line); border-radius: 12px; }
.chathead { padding: 8px 12px; border-bottom: 1px solid var(--line); color: var(--muted); }
.chatlog { flex: 1; overflow: auto; padding: 8px 12px; display: flex; flex-direction: column; gap: 8px; }
.msg { padding: 8px 12px; border-radius: 10px; max-width: 90%; white-space: pre-wrap; }
.msg.q { align-self: flex-end; background: #1d4ed8; }
.msg.a { align-self: flex-start; background: #1e293b; }
.msgbar { margin-top: 6px; }
.shown { color: var(--good); font-size: 13px; }
.chatstatus { padding: 4px 12px; font-size: 13px; color: var(--muted); }
.chatstatus.thinking { color: var(--warn); }
.chatstatus.ok { color: var(--good); }
.chatform { display: flex; gap: 8px; padding: 8px 12px; border-top: 1px solid var(--line); }
.chatform textarea { flex: 1; resize: none; font: inherit; color: var(--text); background: var(--bg);
  border: 1px solid var(--line); border-radius: 8px; padding: 6px 10px; }
.modal { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.7); display: flex; align-items: center;
  justify-content: center; z-index: 10; }
.dialog { background: var(--panel); border: 1px solid var(--line); border-radius: 14px; padding: 20px 24px;
  max-width: 520px; display: flex; flex-direction: column; gap: 12px; }
.dialog h2 { margin: 0; }
.dialog p { margin: 0; color: var(--muted); }
.screens { display: flex; flex-direction: column; gap: 8px; }
.toast { position: fixed; left: 50%; bottom: 24px; transform: translateX(-50%); background: #1e293b;
  border: 1px solid var(--line); border-radius: 10px; padding: 10px 16px; z-index: 11; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; overflow: auto; } }
`;
