import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerNotification, ServerRequest } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { PACES, type Pace, replayRun } from '../replay/replayer.js';
import { VIDEO_FORMATS, type VideoFormat } from '../video/formats.js';
import { slideshow, startVideo, stopVideo } from '../video/recording.js';
import { startProgress } from './developer-tools.js';
import { writeReports } from './run-tools.js';
import { type Content, runTool, textResult } from './util.js';

type Extra = RequestHandlerExtra<ServerRequest, ServerNotification>;

const list = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

// One format or path. Only replay takes a list.
function one<T>(value: T | T[] | undefined, what: string): T | undefined {
  if (!Array.isArray(value)) return value;
  if (value.length > 1)
    throw new ToolError(`Only replay takes more than one ${what}. Give one ${what}.`, 'bad_input');
  return value[0];
}

export function registerVideoTools(server: McpServer, ctx: Context): void {
  server.registerTool(
    'video',
    {
      title: 'Video',
      description: [
        'Record the active tab as a video: MP4, WebM, or GIF. Actions: start records, caption sets the text at the bottom, and stop saves the file.',
        'Walkthrough cuts wait time short, draws the pointer and clicks, and hides the panel and typed secrets.',
        'During a run, the video belongs to the run, and step titles become captions.',
        'slideshow makes a video of the screenshots of a run, with the step titles as captions.',
        'replay records a finished run again for a clean demo: a new login, an even pace, typed text, and a title card.',
      ].join(' '),
      inputSchema: {
        action: z.enum(['start', 'stop', 'status', 'caption', 'slideshow', 'replay']),
        name: z.string().max(60).optional().describe('A name for the file, like "checkout".'),
        text: z
          .string()
          .max(120)
          .optional()
          .describe('For caption: the text at the bottom. An empty text removes it.'),
        format: z
          .union([z.enum(VIDEO_FORMATS), z.array(z.enum(VIDEO_FORMATS)).min(1).max(3)])
          .optional()
          .describe(
            'mp4, webm, or gif. The default comes from path, then config.yaml. A slideshow is a GIF by default. replay takes a list, like [mp4, gif].',
          ),
        path: z
          .union([z.string(), z.array(z.string()).min(1).max(5)])
          .optional()
          .describe(
            'Also save the video to this file, from the project folder, like "docs/images/cart.gif". replay takes a list.',
          ),
        showPanel: z
          .boolean()
          .optional()
          .describe('For start: show the Walkthrough panel in the video.'),
        runId: z
          .string()
          .optional()
          .describe(
            'For slideshow and replay: the run. The default is the run that is going, or the newest run.',
          ),
        pace: z
          .enum(Object.keys(PACES) as [Pace, ...Pace[]])
          .default('normal')
          .describe('For replay: slow, normal, or fast.'),
        session: z
          .string()
          .optional()
          .describe(
            "For replay: a saved login to start with. The default is the run's saved login.",
          ),
        captions: z.boolean().optional().describe('For replay: show step captions.'),
        pointer: z.boolean().optional().describe('For replay: draw the pointer and clicks.'),
        titleCard: z
          .boolean()
          .optional()
          .describe('For replay: start with a card that shows the run name. The default is yes.'),
        width: z
          .number()
          .int()
          .min(320)
          .max(3840)
          .optional()
          .describe('For replay: the width of the page and the video, in pixels.'),
        environment: z
          .string()
          .optional()
          .describe(
            'For replay: replay the run on this environment, like "production". It also switches the session. The default is the environment in use.',
          ),
      },
    },
    (input, extra: Extra) =>
      runTool(ctx, 'video', async () => {
        const video = ctx.video;
        if (input.action === 'status') {
          if (!video) return 'No video is recording.';
          const { capture } = video;
          if (!capture.recording)
            return `The video "${video.name}" stopped, but Walkthrough has not saved it. Call video with action stop to save it.`;
          const seconds = Math.round((Date.now() - capture.startedAt) / 1000);
          return [
            `Recording "${video.name}" for ${seconds} seconds: ${capture.frames.length} picture(s) so far.`,
            video.runId ? `It belongs to the run ${video.runId}.` : '',
            capture.caption ? `Caption: ${capture.caption}` : 'No caption.',
          ]
            .filter(Boolean)
            .join('\n');
        }
        if (input.action === 'caption') {
          if (!video?.capture.recording)
            throw new ToolError(
              'No video is recording. Call video with action start first.',
              'no_video',
            );
          video.capture.setCaption(input.text ?? '');
          return input.text ? `The caption is now: ${input.text}` : 'Removed the caption.';
        }
        if (input.action === 'start') {
          const started = await startVideo(ctx, { name: input.name, showPanel: input.showPanel });
          const tab = ctx.requireDriver().activeTab();
          return [
            `Recording the tab "${tab.name}" (${tab.id}). The video follows the active tab.`,
            started.capture.options.showPanel
              ? 'The video shows the panel, but hides typed secrets.'
              : 'The video hides the panel and typed secrets.',
            started.runId
              ? `The video belongs to the run ${started.runId}. Step titles become captions.`
              : 'Use video with action caption to show text at the bottom.',
            'Call video with action stop to save it.',
          ].join('\n');
        }
        if (input.action === 'replay') {
          const envLines = input.environment
            ? await ctx.useEnvironmentForTool(input.environment, extra)
            : [];
          const stopProgress = startProgress(extra, 'Walkthrough replays the run.');
          try {
            const result = await replayRun(ctx, {
              runId: input.runId,
              formats: list<VideoFormat>(input.format),
              paths: list(input.path),
              pace: input.pace,
              session: input.session,
              captions: input.captions,
              pointer: input.pointer,
              titleCard: input.titleCard,
              width: input.width,
            });
            if (result.ok) writeReports(result.store, await ctx.secrets());
            const reply = textResult(
              [...envLines, ...result.lines].join('\n'),
              result.preview && result.previewType
                ? [{ type: 'image', data: result.preview, mimeType: result.previewType }]
                : [],
            );
            return result.ok ? reply : { ...reply, isError: true };
          } finally {
            stopProgress();
          }
        }
        const format = one<VideoFormat>(input.format, 'format');
        const path = one(input.path, 'path');
        const saved =
          input.action === 'slideshow'
            ? await slideshow(ctx, { runId: input.runId, format, path })
            : await stopVideo(ctx, { format, path, name: input.name });
        // A run that already ended gets its reports again, with the video.
        if (saved.store && saved.store.run.status !== 'running')
          writeReports(saved.store, await ctx.secrets());
        const extraContent: Content[] =
          saved.preview && saved.previewType
            ? [{ type: 'image', data: saved.preview, mimeType: saved.previewType }]
            : [];
        return textResult(saved.lines.join('\n'), extraContent);
      }),
  );
}
