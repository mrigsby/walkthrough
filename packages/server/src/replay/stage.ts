import type { Tab } from '../browser/driver.js';
import type { Rect } from '../panel/controller.js';
import type { VideoCapture } from '../video/capture.js';

// What viewers see while a replay acts: a video, the screen of a live presentation, or nothing.
export interface Stage {
  // A step starts. The text is its caption, or its title.
  stepStart(text: string): void;
  // The pointer moves to an element, or to the page for a key press.
  point(tab: Tab, kind: string, rect?: Rect): Promise<void>;
}

// For steps that run at full speed, like a jump ahead in a presentation.
export class NullStage implements Stage {
  stepStart(): void {}
  async point(): Promise<void> {}
}

// A video: the encoder draws the pointer and the caption from these events later.
export class VideoStage implements Stage {
  constructor(
    private readonly capture: () => VideoCapture | undefined,
    private readonly captions: boolean,
  ) {}

  stepStart(text: string): void {
    if (this.captions) this.capture()?.setCaption(text);
  }

  async point(tab: Tab, kind: string, rect?: Rect): Promise<void> {
    this.capture()?.action(tab.id, kind, rect);
  }
}
