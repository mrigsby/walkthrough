import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Context } from '../context.js';
import { ToolError } from '../errors.js';
import { VIDEO_FORMATS } from '../video/formats.js';
import { slideshow, startVideo, stopVideo } from '../video/recording.js';
import { writeReports } from './run-tools.js';
import { type Content, runTool, textResult } from './util.js';

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
      ].join(' '),
      inputSchema: {
        action: z.enum(['start', 'stop', 'status', 'caption', 'slideshow']),
        name: z.string().max(60).optional().describe('A name for the file, like "checkout".'),
        text: z
          .string()
          .max(120)
          .optional()
          .describe('For caption: the text at the bottom. An empty text removes it.'),
        format: z
          .enum(VIDEO_FORMATS)
          .optional()
          .describe(
            'For stop and slideshow: mp4, webm, or gif. The default comes from path, then config.yaml. A slideshow is a GIF by default.',
          ),
        path: z
          .string()
          .optional()
          .describe(
            'For stop and slideshow: also save the video to this file, from the project folder, like "docs/images/cart.gif".',
          ),
        showPanel: z
          .boolean()
          .optional()
          .describe('For start: show the Walkthrough panel in the video.'),
        runId: z
          .string()
          .optional()
          .describe(
            'For slideshow: the run. The default is the run that is going, or the newest run.',
          ),
      },
    },
    (input) =>
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
        const saved =
          input.action === 'slideshow'
            ? await slideshow(ctx, { runId: input.runId, format: input.format, path: input.path })
            : await stopVideo(ctx, { format: input.format, path: input.path, name: input.name });
        // A run that already ended gets its reports again, with the video.
        if (saved.store && saved.store.run.status !== 'running')
          writeReports(saved.store, await ctx.secrets());
        const extra: Content[] =
          saved.preview && saved.previewType
            ? [{ type: 'image', data: saved.preview, mimeType: saved.previewType }]
            : [];
        return textResult(saved.lines.join('\n'), extra);
      }),
  );
}
