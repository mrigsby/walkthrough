// The messages between the server and the presenter window. Types only, so the
// presenter page can use them too.
import type { Command, CommandType, PresentState } from './session.js';

export interface PresenterStep {
  index: number;
  title: string;
  notes?: string;
  hasAction: boolean;
  pause: boolean;
  slide: boolean;
  timeBudgetSec?: number;
  // Time on the step so far.
  spentMs: number;
}

export interface PresenterChat {
  id: string;
  question?: string;
  answer?: string;
  // waiting: the agent has not seen it. thinking: the agent has it. answered: done.
  state: 'waiting' | 'thinking' | 'answered';
  onScreen: boolean;
}

// Everything that the presenter window shows. The server sends it after each change.
export interface PresenterView {
  name: string;
  runId: string;
  environment: { name: string; label: string; color: string; baseUrl?: string; protected: boolean };
  state: PresentState;
  // The step from 0. steps.length means the end screen.
  current: number;
  blank: boolean;
  titleShown: boolean;
  confirmNeeded?: { name: string; label: string };
  startedAt?: number;
  timeBudgetSec?: number;
  stepElapsedMs: number;
  stepClockRunning: boolean;
  steps: PresenterStep[];
  failure?: { step: number; message: string };
  chat: PresenterChat[];
  listening: boolean;
  // The commands that work now.
  can: CommandType[];
  mirror: boolean;
}

export type PresenterMessage =
  | { type: 'hello' }
  | { type: 'command'; command: Command }
  // A key like the right arrow: start or continue, from the state that the server has.
  | { type: 'next' }
  | { type: 'confirm' }
  | { type: 'cancel' }
  | { type: 'blank' }
  | { type: 'title' }
  | { type: 'fullscreen' }
  | { type: 'screen'; left: number; top: number; width: number; height: number }
  | { type: 'ask'; text: string }
  | { type: 'show'; id: string };

export type ToPresenter =
  | { type: 'view'; view: PresenterView }
  | { type: 'frame'; src: string }
  | { type: 'notice'; text: string };

// What the page gets before its script runs.
export interface PresenterBoot {
  binding: string;
  nonce: string;
}
