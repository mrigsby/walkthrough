import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { resolveDevice } from '../../src/browser/devices.js';
import { comparePng } from '../../src/visual/compare.js';

function image(
  width: number,
  height: number,
  paint?: (x: number, y: number) => [number, number, number],
): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = paint?.(x, y) ?? [255, 255, 255];
      const i = (y * width + x) * 4;
      png.data[i] = r;
      png.data[i + 1] = g;
      png.data[i + 2] = b;
      png.data[i + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

describe('comparePng', () => {
  const white = image(20, 10);
  const dot = image(20, 10, (x, y) => (x < 2 && y < 5 ? [0, 0, 0] : [255, 255, 255]));

  it('finds no change in the same image', () => {
    const result = comparePng(white, image(20, 10));
    expect(result.diffPixels).toBe(0);
    expect(result.diffPng).toBeDefined();
  });

  it('counts changed pixels', () => {
    const result = comparePng(white, dot, []);
    expect(result.diffPixels).toBe(10);
    expect(result.diffPercent).toBe(5);
  });

  it('ignores masked areas', () => {
    expect(comparePng(white, dot, [{ x: 0, y: 0, width: 3, height: 6 }]).diffPixels).toBe(0);
  });

  it('reports a size change', () => {
    const result = comparePng(white, image(20, 12), []);
    expect(result.sameSize).toBe(false);
    expect(result.baselineSize).toEqual({ width: 20, height: 10 });
  });
});

describe('resolveDevice', () => {
  it('knows the presets and Puppeteer devices', () => {
    expect(resolveDevice('desktop')).toEqual({
      label: 'desktop',
      size: { width: 1440, height: 900 },
    });
    expect(resolveDevice('mobile')?.device?.viewport.isMobile).toBe(true);
    expect(resolveDevice('tablet')?.label).toBe('tablet');
    expect(resolveDevice('pixel 5')?.label).toBe('Pixel 5');
    expect(resolveDevice('default')).toBeUndefined();
  });

  it('explains an unknown device', () => {
    expect(() => resolveDevice('toaster')).toThrow(/no device "toaster"/);
  });
});
