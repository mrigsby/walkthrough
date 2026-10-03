---
description: Turn a finished Walkthrough run into a plain Puppeteer script that can run in CI.
argument-hint: "[run folder name] [for <environment>, like: for staging]"
allowed-tools: mcp__plugin_walkthrough_uiwalk__export_script, mcp__plugin_walkthrough_uiwalk__runs
---

Export a finished run as a Puppeteer script.

Run: $ARGUMENTS

1. If no run is given, call `runs`. Show the newest finished runs and ask which one to export.
2. Ask the developer which browser the script should use:
   - `puppeteer` downloads its own Chrome. This works well in CI. This is the default.
   - `puppeteer-core` with the installed Chrome. Use `installedChrome: true`.
3. Call `export_script` with the run folder name and the choice. If the developer named an environment, such as `for staging`, pass it as `environment`.
4. Tell the developer:
   - the path of the script
   - the install command, and ask before you run it
   - the environment variables to set for secrets
   - the lines to fix by hand, and the steps that failed in the run
   - how to run it: `node <path>`, with `BASE_URL` for another address or environment and `HEADFUL=1` to watch
   - if the script has `VARS`: `VAR_<NAME>` changes a value, such as `VAR_SHOPPER`
   - if the script saves screenshots: the files it replaces, and `SHOT=<name>` to save only some of them
   - `VIDEO=<file>.mp4` (or `.webm` or `.gif`) records the first tab as a video, and `PACE_MS=50` waits 50 milliseconds before each browser action. It needs ffmpeg: `FFMPEG_PATH`, the copy from `uiwalk setup ffmpeg`, or `ffmpeg` on the PATH.
