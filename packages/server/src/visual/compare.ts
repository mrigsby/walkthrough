import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';
import type { Rect } from '../panel/controller.js';

export interface Comparison {
  sameSize: boolean;
  width: number;
  height: number;
  baselineSize: { width: number; height: number };
  diffPixels: number;
  diffPercent: number;
  diffPng?: Buffer;
}

// Paints masked areas one flat color, so changing content there is ignored.
function paintMasks(png: PNG, masks: Rect[]): void {
  for (const mask of masks) {
    const x0 = Math.max(0, Math.floor(mask.x));
    const y0 = Math.max(0, Math.floor(mask.y));
    const x1 = Math.min(png.width, Math.ceil(mask.x + mask.width));
    const y1 = Math.min(png.height, Math.ceil(mask.y + mask.height));
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const i = (y * png.width + x) * 4;
        png.data[i] = 255;
        png.data[i + 1] = 0;
        png.data[i + 2] = 255;
        png.data[i + 3] = 255;
      }
    }
  }
}

// Compares two PNG images. "threshold" is how different one pixel may be (0 to 1).
export function comparePng(
  baseline: Buffer,
  actual: Buffer,
  masks: Rect[] = [],
  threshold = 0.1,
): Comparison {
  const a = PNG.sync.read(baseline);
  const b = PNG.sync.read(actual);
  const baselineSize = { width: a.width, height: a.height };
  if (a.width !== b.width || a.height !== b.height) {
    return {
      sameSize: false,
      width: b.width,
      height: b.height,
      baselineSize,
      diffPixels: b.width * b.height,
      diffPercent: 100,
    };
  }
  paintMasks(a, masks);
  paintMasks(b, masks);
  const diff = new PNG({ width: a.width, height: a.height });
  const diffPixels = pixelmatch(a.data, b.data, diff.data, a.width, a.height, { threshold });
  return {
    sameSize: true,
    width: a.width,
    height: a.height,
    baselineSize,
    diffPixels,
    diffPercent: (diffPixels / (a.width * a.height)) * 100,
    diffPng: PNG.sync.write(diff),
  };
}
