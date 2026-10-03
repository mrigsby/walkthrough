import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { Driver } from '../browser/driver.js';
import type { Config } from '../config.js';
import { checkMediaPath } from '../guards/paths.js';
import { VideoCapture } from '../video/capture.js';
import { type EncodeOutput, encodeVideo } from '../video/encoder.js';
import { chooseFormat, type VideoFormat } from '../video/formats.js';
import { VIDEO_FPS } from '../video/recording.js';
import { buildSamples } from '../video/timeline.js';
import type { PresentationSession } from './session.js';

export interface RecordOptions {
  format?: VideoFormat;
  // Also save the video here, from the project folder.
  path?: string;
}

export interface SavedRecording {
  out?: EncodeOutput;
  // The exact path it was also saved to.
  copied?: string;
  note?: string;
}

// Records the audience screen of a presentation. The live pointer and captions are in the
// pictures already. Steps play at normal speed, waits at the gates shrink like other waits,
// and the curtain of a jump is cut.
export class PresentationRecorder {
  private readonly capture: VideoCapture;
  private playingSince?: number;
  private stopWatch?: () => void;

  constructor(
    driver: Driver,
    private readonly session: PresentationSession,
    private readonly config: Config,
  ) {
    this.capture = new VideoCapture(driver, { maxWidth: config.video.width, showPanel: false });
  }

  async start(): Promise<void> {
    await this.capture.start();
    this.stopWatch = this.session.watch(() => this.onChange());
  }

  private onChange(): void {
    const state = this.session.state;
    const playing = state === 'running' || state === 'manual';
    if (playing && this.playingSince === undefined) this.playingSince = Date.now();
    if (!playing && this.playingSince !== undefined) {
      this.capture.activity(this.playingSince);
      this.playingSince = undefined;
    }
  }

  // The curtain hides a jump. Its time is cut from the video.
  curtain(on: boolean): void {
    this.capture.question(on);
  }

  async stop(): Promise<void> {
    this.stopWatch?.();
    if (this.playingSince !== undefined) this.capture.activity(this.playingSince);
    this.playingSince = undefined;
    await this.capture.stop();
  }

  // Encodes the video into the folder. The pictures go away after.
  async save(dir: string, options: RecordOptions): Promise<SavedRecording> {
    const config = this.config;
    try {
      const format = chooseFormat(options.format, options.path, config.video.runFormat);
      const target = options.path
        ? checkMediaPath(options.path, config.projectDir, config.screenshotRoots)
        : undefined;
      const samples = buildSamples(this.capture.frames, this.capture.events, {
        start: this.capture.startedAt,
        end: this.capture.stoppedAt ?? Date.now(),
        fps: format === 'gif' ? config.video.gifFps : VIDEO_FPS,
        idleSeconds: config.video.idleSeconds,
        pointer: false,
        captions: false,
      });
      if (samples.length === 0) return { note: 'The recording has no pictures.' };
      const seconds = samples.reduce((sum, s) => sum + s.duration, 0);
      if (format === 'gif' && seconds > config.video.maxGifSeconds) {
        return {
          note: `The recording is ${Math.round(seconds)} seconds long, and a GIF can have ${config.video.maxGifSeconds} seconds (maxGifSeconds). Record as mp4 or webm.`,
        };
      }
      mkdirSync(dir, { recursive: true });
      const out = await encodeVideo({
        config,
        framesDir: this.capture.dir,
        samples,
        format,
        outFile: join(dir, `presentation.${format}`),
      });
      let copied: string | undefined;
      if (target && out.format === format) {
        mkdirSync(dirname(target.path), { recursive: true });
        copyFileSync(out.file, target.path);
        copied = target.display;
      }
      return { out, ...(copied ? { copied } : {}), ...(out.note ? { note: out.note } : {}) };
    } catch (error) {
      return { note: `Walkthrough did not save the recording: ${(error as Error).message}` };
    } finally {
      this.capture.discard();
    }
  }

  discard(): void {
    this.capture.discard();
  }
}
