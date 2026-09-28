import { extname } from 'node:path';
import { ToolError } from '../errors.js';

// Video file formats that Walkthrough can write.
export const VIDEO_FORMATS = ['mp4', 'webm', 'gif'] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];

export const VIDEO_EXTENSIONS = VIDEO_FORMATS.map((f) => `.${f}`);

// The format to write: the format asked for, then the file extension, then the setting.
export function chooseFormat(
  format: VideoFormat | undefined,
  path: string | undefined,
  fallback: VideoFormat,
): VideoFormat {
  const ext = path ? extname(path).slice(1).toLowerCase() : '';
  const fromPath = (VIDEO_FORMATS as readonly string[]).includes(ext)
    ? (ext as VideoFormat)
    : undefined;
  if (format && fromPath && format !== fromPath) {
    throw new ToolError(
      `The path ends in .${fromPath}, but the format is ${format}. Use the same format in both.`,
      'bad_input',
    );
  }
  return format ?? fromPath ?? fallback;
}
