import type { VideoFormat } from './formats.js';

// One picture in the finished video, shown for "duration" seconds.
// Positions are CSS pixels of the page, like element boxes.
export interface Sample {
  file: string;
  duration: number;
  // The page size in CSS pixels when Chrome took the picture.
  width: number;
  height: number;
  caption?: string;
  pointer?: { x: number; y: number };
  // A click mark. "p" goes from 0 to 1 while it grows and fades.
  ripple?: { x: number; y: number; p: number };
}

// What the encoder page makes. Frames come from frameUrl + file, and the file goes to outUrl.
export interface EncodeJob {
  format: VideoFormat;
  width: number;
  // A fixed height, like for a slideshow of pictures in many sizes.
  // Without it, the first picture sets the shape of the video.
  height?: number;
  samples: Sample[];
  frameUrl: string;
  outUrl: string;
  // A title card before the first frame.
  title?: string;
  // For tests: act as if Chrome cannot make MP4.
  noAvc?: boolean;
}

export interface EncodeResult {
  // WebM when Chrome cannot make MP4. The server then converts it with ffmpeg.
  format: VideoFormat;
  bytes: number;
  seconds: number;
  frames: number;
  width: number;
  height: number;
}
