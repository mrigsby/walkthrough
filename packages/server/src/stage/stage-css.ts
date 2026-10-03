// Styles for the audience screen of a presentation. They live in the stage's shadow root,
// so they do not change the app, and the app does not change them.
export const STAGE_CSS = `
:host {
  all: initial !important; position: fixed !important; inset: 0 !important;
  width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important;
  margin: 0 !important; padding: 0 !important; border: 0 !important; overflow: visible !important;
  background: transparent !important; pointer-events: none !important; color-scheme: normal !important;
}
* { box-sizing: border-box; font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
[hidden] { display: none !important; }

.slide { position: fixed; inset: 0; display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 3vh; padding: 6vh 8vw; background: #111827; color: #ffffff; text-align: center; }
.slide img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; }
.slide h1 { margin: 0; font-size: clamp(32px, 8vh, 112px); font-weight: 700; line-height: 1.1; }
.slide p { margin: 0; font-size: clamp(18px, 3.6vh, 48px); line-height: 1.4; white-space: pre-wrap; opacity: 0.9; }

.spot { position: fixed; border-radius: 8px; box-shadow: 0 0 0 200vmax rgba(0, 0, 0, 0.55);
  outline: 3px solid #fbbf24; outline-offset: 4px; transition: all 250ms ease; }

.zoom { position: fixed; left: 50%; top: 50%; transform: translate(-50%, -50%); max-width: 80vw; max-height: 70vh;
  padding: 6px; border-radius: 12px; background: #ffffff; box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6); }
.zoom .lens { position: relative; overflow: hidden; border-radius: 8px; background: #111827; }
.zoom img { position: absolute; display: block; max-width: none; max-height: none; }

.caption { position: fixed; left: 0; right: 0; bottom: 0; padding: 2.2vh 4vw;
  background: rgba(17, 24, 39, 0.86); color: #ffffff; font-size: max(16px, 3.2vh); font-weight: 600;
  line-height: 1.3; text-align: center; }

.pointer { position: fixed; left: 0; top: 0; width: 28px; height: 28px;
  transition-property: transform; transition-timing-function: ease-in-out;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.5)); }
.ripple { position: fixed; width: 44px; height: 44px; margin: -22px 0 0 -22px; border-radius: 50%;
  border: 3px solid #fbbf24; opacity: 0; }
.ripple.go { animation: uiwalk-ripple 500ms ease-out; }
@keyframes uiwalk-ripple { from { transform: scale(0.3); opacity: 1; } to { transform: scale(1.6); opacity: 0; } }

.cover { position: fixed; inset: 0; background: #000000; display: flex; align-items: center; justify-content: center;
  color: #9ca3af; font-size: max(18px, 3vh); }
`;
