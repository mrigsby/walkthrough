import { homedir } from 'node:os';
import { join } from 'node:path';

// Where "uiwalk setup" saves Chrome, Lighthouse, and ffmpeg.
export const CACHE_DIR = process.env.UIWALK_CACHE_DIR ?? join(homedir(), '.cache', 'uiwalk');

// The command that runs this server file, so messages work with or without npm.
export const SELF = process.argv[1] ? `node "${process.argv[1]}"` : 'npx -y walkthrough-ui';
