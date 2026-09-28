import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  renameSync,
  rmSync,
  statSync,
} from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { killChrome, launchChrome, removeProfile } from '../browser/launch.js';
import type { Config } from '../config.js';
import { FFMPEG_MISSING, findFfmpeg } from '../downloads/ffmpeg.js';
import { ToolError } from '../errors.js';
import type { EncodeJob, EncodeResult, Sample } from './encode-job.js';
import { encoderSource } from './encoder-source.js';
import type { VideoFormat } from './formats.js';

export interface EncodeOutput {
  file: string;
  format: VideoFormat;
  seconds: number;
  bytes: number;
  width: number;
  height: number;
  // Something the developer should know, like a WebM file instead of MP4.
  note?: string;
}

// Converts WebM to MP4 with ffmpeg.
function toMp4(ffmpeg: string, input: string, output: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      [
        '-y',
        '-loglevel',
        'error',
        '-i',
        input,
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        '-movflags',
        '+faststart',
        output,
      ],
      { stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errors = '';
    child.stderr.on('data', (chunk) => {
      errors += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(errors.trim() || `ffmpeg ended with code ${code}`)),
    );
  });
}

// Encodes the pictures of a recording in a hidden Chrome. The pictures and the finished
// file go through a server on 127.0.0.1, at a path with a random token.
export async function encodeVideo(options: {
  config: Config;
  framesDir: string;
  samples: Sample[];
  format: VideoFormat;
  // The file to write. Its extension matches the format.
  outFile: string;
  title?: string;
  // A fixed size, like for a slideshow. The default width comes from config.yaml.
  width?: number;
  height?: number;
}): Promise<EncodeOutput> {
  const { config, format, outFile } = options;
  const token = randomBytes(16).toString('hex');
  const part = `${outFile}.part`;
  const page = `<!doctype html><meta charset="utf-8"><title>uiwalk encoder</title><script>${await encoderSource()}</script>`;
  const server = createServer((req, res) => {
    const url = req.url ?? '';
    if (req.method === 'GET' && url === `/${token}/`) {
      res.setHeader('content-type', 'text/html');
      res.end(page);
      return;
    }
    const frame = new RegExp(`^/${token}/frames/(\\d+\\.(jpg|jpeg|png|webp))$`).exec(url);
    if (req.method === 'GET' && frame?.[1] && existsSync(join(options.framesDir, frame[1]))) {
      res.setHeader('content-type', `image/${frame[2] === 'jpg' ? 'jpeg' : frame[2]}`);
      createReadStream(join(options.framesDir, frame[1])).pipe(res);
      return;
    }
    if (req.method === 'POST' && url === `/${token}/out`) {
      const file = createWriteStream(part);
      req.pipe(file);
      file.on('finish', () => res.end('ok'));
      file.on('error', () => {
        res.statusCode = 500;
        res.end();
      });
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/${token}`;

  const job: EncodeJob = {
    format,
    width: options.width ?? (format === 'gif' ? config.video.gifWidth : config.video.width),
    height: options.height,
    samples: options.samples,
    frameUrl: `${base}/frames/`,
    outUrl: `${base}/out`,
    title: options.title,
    noAvc: process.env.UIWALK_VIDEO_NO_CHROME_MP4 === '1',
  };
  let result: EncodeResult;
  const { browser, profileDir } = await launchChrome(config, { background: true });
  try {
    const tab = await browser.newPage();
    await tab.goto(`${base}/`);
    result = await tab.evaluate(
      (j) =>
        (
          window as unknown as { uiwalkEncode: (j: EncodeJob) => Promise<EncodeResult> }
        ).uiwalkEncode(j),
      job,
    );
  } catch (error) {
    rmSync(part, { force: true });
    throw new ToolError(
      `Walkthrough could not encode the video: ${(error as Error).message}`,
      'video_failed',
    );
  } finally {
    await killChrome(browser);
    removeProfile(profileDir);
    server.close();
  }

  const done = (file: string, made: VideoFormat, note?: string): EncodeOutput => ({
    file,
    format: made,
    seconds: result.seconds,
    bytes: result.bytes,
    width: result.width,
    height: result.height,
    note,
  });
  if (result.format === format) {
    renameSync(part, outFile);
    return done(outFile, format);
  }

  // Chrome made WebM because it cannot make MP4 here. ffmpeg converts it.
  const webm = outFile.replace(/\.mp4$/i, '.webm');
  renameSync(part, webm);
  const ffmpeg = findFfmpeg({ configPath: config.ffmpegPath });
  if (!ffmpeg) {
    return done(
      webm,
      'webm',
      `This Chrome cannot make MP4, and ffmpeg is missing, so the video is WebM. ${FFMPEG_MISSING}`,
    );
  }
  try {
    await toMp4(ffmpeg.path, webm, outFile);
  } catch (error) {
    return done(
      webm,
      'webm',
      `ffmpeg could not make MP4, so the video is WebM: ${(error as Error).message}`,
    );
  }
  rmSync(webm, { force: true });
  return {
    ...done(outFile, 'mp4', `This Chrome cannot make MP4, so ffmpeg (${ffmpeg.source}) made it.`),
    bytes: statSync(outFile).size,
  };
}
