// The encoder page. It runs in a hidden Chrome, draws each picture of the video with the
// pointer, click marks, and captions, and encodes GIF, WebM, or MP4.
// The build turns this file into one script (see scripts/build-plugin.mjs).
import { applyPalette, GIFEncoder, quantize } from 'gifenc';
import {
  BufferTarget,
  CanvasSource,
  canEncodeVideo,
  Mp4OutputFormat,
  Output,
  QUALITY_MEDIUM,
  WebMOutputFormat,
} from 'mediabunny';
import type { EncodeJob, EncodeResult, Sample } from '../encode-job.js';

const TITLE_SECONDS = 1.5;

type Ctx2D = OffscreenCanvasRenderingContext2D;

// The last picture stays loaded, because many samples reuse it.
let loaded: { file: string; bitmap: ImageBitmap } | undefined;
async function picture(job: EncodeJob, file: string): Promise<ImageBitmap> {
  if (loaded?.file === file) return loaded.bitmap;
  const response = await fetch(job.frameUrl + file);
  if (!response.ok) throw new Error(`Could not load frame ${file}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());
  loaded?.bitmap.close();
  loaded = { file, bitmap };
  return bitmap;
}

function drawPointer(g: Ctx2D, x: number, y: number, size: number): void {
  // An arrow like the system pointer, white with a dark edge.
  const s = size / 20;
  g.save();
  g.translate(x, y);
  g.scale(s, s);
  g.beginPath();
  g.moveTo(0, 0);
  g.lineTo(0, 17);
  g.lineTo(4.5, 13);
  g.lineTo(7.5, 19.5);
  g.lineTo(10.5, 18);
  g.lineTo(7.5, 11.5);
  g.lineTo(13, 11.5);
  g.closePath();
  g.fillStyle = '#ffffff';
  g.strokeStyle = '#111827';
  g.lineWidth = 1.5;
  g.fill();
  g.stroke();
  g.restore();
}

function drawRipple(g: Ctx2D, x: number, y: number, p: number, size: number): void {
  // Amber with a dark edge, so it shows on light and dark pages.
  const r = size * (0.4 + p * 1.2);
  const fade = 1 - p;
  g.save();
  g.beginPath();
  g.arc(x, y, r, 0, Math.PI * 2);
  g.fillStyle = `rgba(251, 191, 36, ${0.3 * fade})`;
  g.fill();
  g.lineWidth = Math.max(3, size / 5);
  g.strokeStyle = `rgba(17, 24, 39, ${0.6 * fade})`;
  g.stroke();
  g.lineWidth = Math.max(2, size / 8);
  g.strokeStyle = `rgba(251, 191, 36, ${0.95 * fade})`;
  g.stroke();
  g.restore();
}

// Breaks text into at most two lines that fit the width.
function lines(g: Ctx2D, text: string, width: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let line = '';
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (g.measureText(next).width <= width || !line) line = next;
    else {
      out.push(line);
      line = word;
    }
  }
  if (line) out.push(line);
  if (out.length > 2) {
    let last = out[1] as string;
    while (last && g.measureText(`${last}...`).width > width) last = last.slice(0, -1);
    return [out[0] as string, `${last.trimEnd()}...`];
  }
  return out;
}

function drawCaption(g: Ctx2D, text: string, w: number, h: number): void {
  const font = Math.max(14, Math.round(h * 0.034));
  g.font = `600 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  const pad = Math.round(font * 0.7);
  const rows = lines(g, text, w - pad * 2);
  const band = rows.length * Math.round(font * 1.3) + pad * 2 - Math.round(font * 0.3);
  g.fillStyle = 'rgba(17, 24, 39, 0.82)';
  g.fillRect(0, h - band, w, band);
  g.fillStyle = '#ffffff';
  g.textBaseline = 'top';
  rows.forEach((row, i) => {
    g.fillText(row, pad, h - band + pad + i * Math.round(font * 1.3));
  });
}

function drawTitle(g: Ctx2D, title: string, w: number, h: number): void {
  g.fillStyle = '#111827';
  g.fillRect(0, 0, w, h);
  const font = Math.max(18, Math.round(h * 0.06));
  g.font = `700 ${font}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  g.fillStyle = '#ffffff';
  g.textBaseline = 'middle';
  const rows = lines(g, title, w * 0.8);
  rows.forEach((row, i) => {
    const x = (w - g.measureText(row).width) / 2;
    g.fillText(row, x, h / 2 + (i - (rows.length - 1) / 2) * font * 1.3);
  });
}

async function drawSample(
  g: Ctx2D,
  job: EncodeJob,
  sample: Sample,
  w: number,
  h: number,
): Promise<void> {
  const bitmap = await picture(job, sample.file);
  g.fillStyle = '#111827';
  g.fillRect(0, 0, w, h);
  // Fit the picture inside the video. A tab of another size gets bars.
  const fit = Math.min(w / bitmap.width, h / bitmap.height);
  const dw = bitmap.width * fit;
  const dh = bitmap.height * fit;
  const dx = (w - dw) / 2;
  const dy = (h - dh) / 2;
  g.drawImage(bitmap, dx, dy, dw, dh);
  // CSS pixels to video pixels.
  const k = sample.width ? dw / sample.width : 1;
  const size = Math.max(14, Math.round(h * 0.03));
  if (sample.ripple)
    drawRipple(g, dx + sample.ripple.x * k, dy + sample.ripple.y * k, sample.ripple.p, size);
  if (sample.pointer) drawPointer(g, dx + sample.pointer.x * k, dy + sample.pointer.y * k, size);
  if (sample.caption) drawCaption(g, sample.caption, w, h);
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function encode(job: EncodeJob): Promise<EncodeResult> {
  const first = job.samples[0];
  if (!first) throw new Error('The recording has no frames.');
  const firstPicture = await picture(job, first.file);
  const w = even(job.height ? job.width : Math.min(job.width, firstPicture.width));
  const h = even(job.height ?? (firstPicture.height * w) / firstPicture.width);
  const canvas = new OffscreenCanvas(w, h);
  const g = canvas.getContext('2d', { willReadFrequently: job.format === 'gif' }) as Ctx2D;

  let seconds = 0;
  let frames = 0;
  let bytes: Uint8Array;
  let format = job.format;

  if (format === 'gif') {
    const gif = GIFEncoder();
    const add = (duration: number) => {
      const { data } = g.getImageData(0, 0, w, h);
      const palette = quantize(data, 256);
      // GIF delays are in steps of 10 ms. Very short delays play too slowly in some viewers.
      gif.writeFrame(applyPalette(data, palette), w, h, {
        palette,
        delay: Math.max(20, Math.round((duration * 1000) / 10) * 10),
      });
      seconds += duration;
      frames += 1;
    };
    if (job.title) {
      drawTitle(g, job.title, w, h);
      add(TITLE_SECONDS);
    }
    for (const sample of job.samples) {
      await drawSample(g, job, sample, w, h);
      add(sample.duration);
    }
    gif.finish();
    bytes = gif.bytes();
  } else {
    const avc =
      format === 'mp4' && !job.noAvc && (await canEncodeVideo('avc', { width: w, height: h }));
    // Without H.264, make WebM. The server converts it to MP4 with ffmpeg.
    if (format === 'mp4' && !avc) format = 'webm';
    const codec = avc
      ? 'avc'
      : (await canEncodeVideo('vp9', { width: w, height: h }))
        ? 'vp9'
        : 'vp8';
    const output = new Output({
      format:
        format === 'mp4' ? new Mp4OutputFormat({ fastStart: 'in-memory' }) : new WebMOutputFormat(),
      target: new BufferTarget(),
    });
    const source = new CanvasSource(canvas, { codec, quality: QUALITY_MEDIUM });
    output.addVideoTrack(source);
    await output.start();
    if (job.title) {
      drawTitle(g, job.title, w, h);
      await source.add(seconds, TITLE_SECONDS);
      seconds += TITLE_SECONDS;
      frames += 1;
    }
    for (const sample of job.samples) {
      await drawSample(g, job, sample, w, h);
      await source.add(seconds, sample.duration);
      seconds += sample.duration;
      frames += 1;
    }
    await output.finalize();
    bytes = new Uint8Array((output.target as BufferTarget).buffer as ArrayBuffer);
  }

  const sent = await fetch(job.outUrl, { method: 'POST', body: bytes as BodyInit });
  if (!sent.ok) throw new Error(`Could not send the video: HTTP ${sent.status}`);
  return { format, bytes: bytes.byteLength, seconds, frames, width: w, height: h };
}

(window as unknown as { uiwalkEncode: typeof encode }).uiwalkEncode = encode;
