// Video file formats that Walkthrough can write.
export const VIDEO_FORMATS = ['mp4', 'webm', 'gif'] as const;
export type VideoFormat = (typeof VIDEO_FORMATS)[number];
