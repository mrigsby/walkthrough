# Videos

Walkthrough can make a video or a GIF of your app. Use one to show a feature in your docs, to show a bug in an issue, or to share a demo with your team.

| You want | Use |
| --- | --- |
| A clean demo video of a workflow | [Quick start](#quick-start), or [the `/walkthrough:video` command](#the-walkthroughvideo-command) |
| A video of what you and the agent do now | [Record part of a session](#record-part-of-a-session) |
| A video of a whole test run | [Record a whole run](#record-a-whole-run) |
| A GIF or a video in your docs folder | [Save to an exact file](#save-to-an-exact-file) |
| A short video of a bug | [Bug clips](#bug-clips) |
| A GIF of the screenshots of a run | [Step slideshow](#step-slideshow) |
| The same demo again, such as after the app changes | [Clean re-recordings](#clean-re-recordings) |
| A video of a live presentation | [Record a presentation](#record-a-presentation) |

## Quick start

1. Start your app. If the project has no `.walkthrough` folder yet, run `/walkthrough:init` first. See [Getting started](getting-started.md).
2. Ask the agent:

   ```text
   Create a recording demo of the checkout workflow
   ```

The agent then does these steps:

1. It looks at the app to find the real names of the buttons, links, and fields.
2. It writes a plan for the workflow, with a short caption on each step. It saves the plan, such as `.walkthrough/plans/checkout-demo.yaml`.
3. It runs the plan once and checks each step. If a step fails, it stops and tells you why.
4. It records the run again as a clean replay, in a new login, at an even pace.
5. It tells you where the files are, and the length and size of each file.

The agent asks you a question only when it needs a fact, such as a login or test data.

You get two files in the `video/` folder of the run (`.walkthrough/runs/<run>/video/`):

- `<time>-replay.mp4`: the video to watch and to share.
- `<time>-replay.gif`: a preview for Markdown files and issues.

The video starts with a title card that shows the plan name. The pointer moves to each element, and text appears one character at a time. A caption at the bottom says what happens. The Walkthrough panel does not show, and the video has no long waits.

The run and the replay each do the workflow once. When the workflow makes data, such as an order, the app gets it two times.

After that, you can ask for changes, such as:

- "Make it slower and save a GIF to docs/images/checkout.gif."
- "Make it again as a WebM, without the title card."

The agent records the same run again. It does not run the plan again.

## The `/walkthrough:video` command

```text
/walkthrough:video <workflow or plan> [mp4 | webm | gif] [path]
```

- The first argument is a workflow in plain words, such as `the checkout`, or the name of a saved plan, such as `checkout-demo`.
- `mp4`, `webm`, or `gif` picks the format. Without it, you get an MP4 and a GIF.
- An argument that ends in `.mp4`, `.webm`, or `.gif` is a file to save the video to.

| Command | What you get |
| --- | --- |
| `/walkthrough:video the checkout` | A new plan, a run, and a replay as an MP4 and a GIF. |
| `/walkthrough:video checkout-demo` | A run of the saved plan, and a replay as an MP4 and a GIF. |
| `/walkthrough:video checkout-demo gif docs/images/checkout.gif` | A GIF in the run folder, and a copy at `docs/images/checkout.gif`. |
| `/walkthrough:video sign up for the newsletter webm` | A new plan, a run, and a replay as a WebM. |

The agent uses a saved plan only when its name or title says that it is a demo or a video of the workflow. It does not use a normal test plan for a video, because test plans check for bugs, and their steps can fail.

## Record part of a session

The `video` tool records what happens in the browser now, like a screen recorder. For example, ask:

> Start a video. Add the mug and the shirt to the cart, and open the cart. Then stop the video and save it as a GIF at docs/images/cart.gif.

The agent:

1. Calls `video` with action `start`. Walkthrough records the active tab. When the agent opens another tab or changes to it, the video follows.
2. Does the steps.
3. Calls `video` with action `stop`, `format: gif`, and `path: docs/images/cart.gif`.

To show text at the bottom of the video, ask for a caption, such as "set the caption to Add two items". The agent calls `video` with action `caption`. An empty caption removes it. `video` with action `status` shows what is recording.

- Walkthrough cuts each wait, such as the agent thinking, to about 1 second (`video.idleSeconds`).
- It draws the pointer and marks each click of the agent.
- Without a run, the files go in `.walkthrough/runs/adhoc-<day>/video/`, as `<time>-<name>.<format>`.

Walkthrough sees only the actions of the agent. When you use the app yourself during a recording, Walkthrough cuts that time like a wait. To make a video of your own steps, record them as a plan with `/walkthrough:record`. Then run `/walkthrough:video` with the exact name of that plan.

## Record a whole run

A plan with a `video` key records the whole run:

```yaml
name: Checkout
mode: autonomous
video: true
steps:
  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug
    action: { click: { selector: '[data-add="mug"]' } }
    caption: Add the coffee mug to the cart
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    caption: Open the cart
```

- `video: true` uses the format from `video.runFormat` in `config.yaml` (MP4).
- The object form sets more: `video: { format: gif, path: docs/images/checkout.gif, showPanel: true, captions: false }`.
- To record a plan without a `video` key, ask for it, such as "run the checkout plan and record a video". The agent calls `run_start` with `video: true`.
- The caption of each step is its `caption` key, or its `do` text.
- `run_finish` saves the video as `video/run.<format>` in the run folder. `report.html` plays it at the top.

The panel shows only while it asks you a question, and the video leaves out that time. Walkthrough cuts wait time to about 1 second.

## Save to an exact file

For docs, save a video to an exact file with `path`. The `stop`, `slideshow`, and `replay` actions take it, and so does the plan key `video`.

- The file must be in the project folder, and not in a hidden folder such as `.git`. To save to another folder, add it to `screenshotRoots` in `config.local.yaml`. See [Settings](config.md).
- Walkthrough replaces the file if it exists. The run folder also keeps its own copy.
- Without `format`, the extension of the path sets the format. Walkthrough refuses a path and a format that do not match.
- MP4 and WebM videos are `video.width` pixels wide (1280). A GIF is `video.gifWidth` pixels wide (800), with `video.gifFps` pictures each second (10).
- A GIF is much bigger than an MP4 of the same video. Keep GIFs short. For more than a few seconds, use MP4 where you can.

## Bug clips

During a run, Walkthrough keeps the last 3 minutes of the active tab in a temp folder. Walkthrough saves a clip of the last seconds when:

- a step fails or is blocked, or
- you click **Bug** in the panel.

Walkthrough cuts the waits from those minutes. Then it saves the last 15 seconds (`video.replaySeconds`) as `video/bug-<step>.gif` in the run folder. `video.bugFormat` sets the format.

- The step card in `report.html` plays the clip.
- `/walkthrough:bug` lists the clip with the screenshots and the HAR file. Drag the files into the issue before you submit it.
- The panel shows in bug clips, because you use it during the run. Walkthrough hides typed secrets.
- A run that records a whole video cuts its bug clips from that video.
- `video.replaySeconds: 0` turns bug clips off. Walkthrough then keeps nothing.

## Step slideshow

A slideshow is a GIF of the screenshots of a run. Ask "make a slideshow GIF of the last run". The agent calls `video` with action `slideshow`.

The slideshow starts with a title card that shows the run name. Then it shows each screenshot of the run for 2 seconds, with the step title as the caption. It goes in `video/slideshow.gif` in the run folder. `format` and `path` work like they do for `stop`. A plan that saves a screenshot at each step, such as the `help-shots` plan in the demo, makes a good slideshow.

## Record a presentation

A presentation can record its audience screen. Add `record` to the `presentation` block of the plan:

```yaml
presentation:
  record: true                                         # the format from video.runFormat
  # record: { format: gif, path: docs/images/tour.gif }  # or a format and a file
```

The video shows what the audience saw: the slides, the spotlight, the pointer, and the captions. Walkthrough draws none of these again. Steps play at normal speed, long pauses become `video.idleSeconds`, and the "One moment" screens of a jump are cut. The video goes in the handout folder, and the handout plays it. See [Presentations](presentations.md#after-the-talk).

## Clean re-recordings

`video` with action `replay` records a finished run again, for a clean demo video. It does not make a new run, and the results of the run do not change. `/walkthrough:video` uses it.

### How a replay works

- It opens a new login in a new window, so it starts with no cookies and no storage. `session` loads a saved login first. The default is the `session` of the plan.
- It uses the screen and the settings of the run. Without a device, the page is `width` pixels wide (1280) at 16:10.
- It uses the environment in use. With `environment`, it switches first. A run from another environment goes to the same pages there, and uses the values of `{{var:NAME}}` from the environment in use. For example, rehearse on development, and record the video on staging. See [Environments](environments.md).
- It makes a new `{{unique}}` value, so new data does not clash with the data from the run.
- It types text one character at a time. It moves the pointer to each element, with the element in the middle of the screen.
- After each action, it waits for the network to settle. When the `expect` of a step has quoted text, it waits for that text.
- It holds at the end of each step, so viewers can follow.
- It answers dialogs like the run did. When the run has no answer for a dialog, it accepts the dialog.
- The video starts with a title card, and shows captions and the pointer. Walkthrough cuts no time from a replay.
- It hides the panel, and it hides a field before it types a secret into it.
- At the end, it closes its tabs and its login. The tab from before is active again.

When a step does not work, the replay stops. The reply names the step and the error, and it has a screenshot. Walkthrough saves no video then.

### Replay options

| Option | What it does | Default |
| --- | --- | --- |
| `runId` | The run to record again. | The newest finished run. |
| `format` | One format, or a list of up to 3, such as `[mp4, gif]`. | `video.runFormat` (MP4). `/walkthrough:video` asks for `[mp4, gif]`. |
| `path` | One file, or a list of up to 5. Each file gets the format of its extension. | None |
| `pace` | `slow`, `normal`, or `fast`. | `normal` |
| `session` | A saved login to start with. | The `session` of the plan. |
| `environment` | The environment to record on, such as `staging`. It switches the session. | The environment in use. |
| `captions` | `false` leaves out the captions. | `video.captions` (on) |
| `pointer` | `false` leaves out the pointer. | `video.pointer` (on) |
| `titleCard` | `false` leaves out the title card. | On |
| `width` | The width of the page and the video, in pixels, from 320 to 3840. | `video.width` (1280) |

Some requests, and the call that the agent makes:

| You say | The agent calls `video` with |
| --- | --- |
| "Replay the last run slower, as a GIF at docs/images/checkout.gif." | `{ action: replay, pace: slow, path: docs/images/checkout.gif }` |
| "Make a 1920 pixel wide MP4 with no title card." | `{ action: replay, format: mp4, width: 1920, titleCard: false }` |
| "Make the demo video again, without captions." | `{ action: replay, format: [mp4, gif], captions: false }` |

### Make the workflow repeatable

Each replay does the workflow again, in the real app. The workflow must work each time.

- **New data:** use `{{unique}}` in values that must be new, such as `demo+{{unique}}@example.com`. Each run and each replay gets a new value.
- **Passwords:** put them in `.walkthrough/.env`, and use `{{secret:NAME}}` in the plan. The agent never sees the values.
- **Start logged in:** save a login with the `session` tool, and add `session: <name>` to the plan. The replay loads that login into its new login.
- **A second user:** a step with `action: { newTab: { isolated: true } }` opens a tab with a login of its own. The replay gives that tab a new login too.
- **Clean start:** the replay has no data from earlier runs, such as items in a cart. Add steps that make the data that the workflow needs.
- **Clean up:** some data stops the next try, such as a coupon that works only once. Add a last step that removes that data. Or use `{{unique}}`, so each try uses new data.
- **Data that changes:** when the page shows data that changes, such as stock or prices, give it fixed data with a `mock` step:

  ```yaml
  - id: open-shop
    do: Open the shop page
    mock:
      - { url: /api/stock, json: { inStock: true } }
    action: { navigate: / }
  ```

- **Exact actions:** give every step an `action`, such as `{ click: { role: button, name: Checkout } }`. Walkthrough cannot replay an action that has no stable selector. The reply names those steps.

### Pace, size, and captions

| Pace | Typing, for each character | Pointer move | Hold at the end of each step |
| --- | --- | --- | --- |
| `slow` | 90 ms | 0.6 seconds | 1.8 seconds |
| `normal` | 50 ms | 0.4 seconds | 1.2 seconds |
| `fast` | 20 ms | 0.2 seconds | 0.7 seconds |

A typed value takes no more than 3 seconds, however long it is.

For the size, set `width`, or put a `device` in the plan, such as `device: mobile`. A replay with a device uses the screen of that device.

Write captions for viewers. A good caption has 3 to 7 words, says what happens on the screen, and starts with a verb. It does not name code, selectors, or fields that the viewer cannot see.

| `do` (for the agent) | `caption` (for viewers) |
| --- | --- |
| Click "Add to cart" on the Coffee Mug | Add the coffee mug to the cart |
| Type a new email address in the Email field | Enter your email address |
| Type the test card 4242 4242 4242 4242 in the Card number field of the payment form | Enter the card number |
| Click "Place order" and accept the confirm dialog | Place the order |

### After the app changes

A replay uses the selectors from its run. After the UI changes, make a new run first:

1. Run `/walkthrough:video checkout-demo`. The run checks each step in the new UI. When every step passes, the replay records the new UI.
2. If a step fails because an element changed, fix the `action` of that step in the plan. The agent can find the new names with `snapshot`.
3. Run `/walkthrough:video checkout-demo` again.

To change only the look of a video, such as the pace or the width, replay the same run. You do not need a new run.

### Make the video again in CI

An exported script can record a video without an agent. Use it to update a demo video in CI after each change to the app.

1. Make a run of the plan, such as with `/walkthrough:video checkout-demo`.
2. Run `/walkthrough:export` for that run. It writes `.walkthrough/exports/checkout-demo.mjs`. Commit the script.
3. Run the script with `VIDEO`:

   ```sh
   VIDEO=docs/videos/checkout.mp4 PACE_MS=50 node .walkthrough/exports/checkout-demo.mjs
   ```

An example for GitHub Actions:

```yaml
name: Demo video
on: workflow_dispatch

jobs:
  video:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - name: Install ffmpeg
        run: sudo apt-get update && sudo apt-get install -y ffmpeg
      - name: Start the app
        run: |
          npm start &
          until curl -s http://localhost:3000 > /dev/null; do sleep 1; done
      - name: Record the checkout demo
        run: node .walkthrough/exports/checkout-demo.mjs
        env:
          BASE_URL: http://localhost:3000
          VIDEO: docs/videos/checkout.mp4
          PACE_MS: 50
      - uses: actions/upload-artifact@v4
        with:
          name: checkout-video
          path: docs/videos/checkout.mp4
```

The project needs `puppeteer` as a dev dependency. See [Run tests in CI](sharing.md#run-tests-in-ci).

A video from a script is plainer than a replay:

- It records only the first tab.
- It has no captions, no pointer, and no title card.
- `PACE_MS` waits that many milliseconds before each browser action. It does not type one character at a time.

For a video with all of these, use `video` with action `replay` in Walkthrough. See [Make a video again](sharing.md#make-a-video-again) for the script options.

## Formats

| Format | Plays in | Notes |
| --- | --- | --- |
| MP4 | Most video players, such as QuickTime and Windows Media Player. PowerPoint, Keynote, and Slack. GitHub issues, pull requests, and comments, when you drag the file in. | Small files. The best choice for most videos. |
| WebM | Chrome, Firefox, Edge, and other browsers. VLC. | Some players, such as QuickTime, do not play it. |
| GIF | Every place that shows images: Markdown files, READMEs, email, issues, and chat. | Large files, at most 256 colors, and no play controls. Up to `video.maxGifSeconds` long (60 seconds). |

For a README or another Markdown file, use a GIF. GitHub limits the size of files that you attach to an issue or a comment, such as 10 MB for a GIF. See [Attaching files](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files) in the GitHub docs.

### How Walkthrough makes MP4

A hidden Chrome encodes each video. For MP4, Walkthrough asks that Chrome for H.264. When the Chrome cannot make H.264, Walkthrough makes a WebM and converts it to MP4 with ffmpeg. When ffmpeg is also missing, the video stays a WebM, and the reply gives the command to install ffmpeg.

Walkthrough uses the first ffmpeg that it finds, in this order:

1. `ffmpegPath` in `config.local.yaml`
2. the `UIWALK_FFMPEG` environment variable
3. `ffmpeg` on the `PATH`
4. the copy from `uiwalk setup ffmpeg`

To get the copy, run this in a terminal. In Claude Code, the reply of the `video` tool shows the exact command for the plugin.

```sh
npx -y walkthrough-ui setup ffmpeg
```

The command downloads a pinned ffmpeg build and checks its SHA-256 hash. On Linux and Windows, the build comes from [ffmpeg-static](https://github.com/eugeneware/ffmpeg-static). On macOS, it comes from the signed builds of [Martin Riedl](https://ffmpeg.martin-riedl.de). The file goes in `~/.cache/uiwalk/ffmpeg`.

### Licenses

- ffmpeg builds use the GPL. Walkthrough does not include ffmpeg. It runs ffmpeg as a separate program. `uiwalk setup ffmpeg` prints the name of the license and saves the license text as `LICENSE.txt` next to the program.
- The encoder in the hidden Chrome uses [Mediabunny](https://github.com/Vanilagy/mediabunny) (MPL-2.0) and [gifenc](https://github.com/mattdesl/gifenc) (MIT). Their license texts are in `plugins/walkthrough/server/THIRD_PARTY_LICENSES.txt`.

## Privacy

- Walkthrough hides the panel in videos, except in bug clips.
- Walkthrough hides a field before the agent types a secret into it. Password fields show dots.
- A video shows everything else on the screen, such as names, email addresses, and data. Walkthrough removes secrets from text, but it does not check the pictures of a video. A secret that the page shows, such as an API key on a settings page, shows in the video.
- Use test accounts and test data, and watch a video before you share it.
- Videos stay in the run folder, which Git does not track. A `path` puts a copy where you choose, such as a docs folder that Git tracks.

## Settings

The `video` block in `.walkthrough/config.yaml` sets the defaults. `config.local.yaml` can change one setting, and the others keep their values.

```yaml
video:
  runFormat: mp4      # mp4, webm, or gif, for runs, the video tool, and replays
  bugFormat: gif      # for bug clips
  width: 1280         # MP4 and WebM width
  gifWidth: 800
  gifFps: 10
  maxGifSeconds: 60   # Walkthrough refuses longer GIFs
  idleSeconds: 1      # Walkthrough cuts each wait to this
  replaySeconds: 15   # bug clip length. 0 turns bug clips off
  showPanel: false
  pointer: true
  captions: true
```

See [Settings](config.md#video) for the range of each setting.

## Troubleshooting

### I asked for MP4, but I got a WebM

The hidden Chrome cannot make H.264, and Walkthrough did not find ffmpeg. Install ffmpeg (see [How Walkthrough makes MP4](#how-walkthrough-makes-mp4)), then make the video again. `/walkthrough:doctor` shows whether Walkthrough finds ffmpeg.

### The video freezes

Chrome draws nothing for a minimized window, so the video shows the same picture. Walkthrough restores the window when a recording starts. Do not minimize it while it records. When Walkthrough uses your own Chrome (`attach`), a window behind other windows can also stop the video. Keep that window in front.

### Walkthrough refuses the GIF

A GIF can be up to `video.maxGifSeconds` long (60 seconds). `stop` keeps the recording, so you can call `stop` again with `format: mp4` or `webm`. A replay still makes the other formats, and says why there is no GIF. To allow longer GIFs, raise `video.maxGifSeconds` (up to 600).

### The file is too big

- Use MP4 instead of GIF.
- Make the video shorter. Record fewer steps, or use `pace: fast`.
- Lower `video.gifWidth` or `video.gifFps` for a GIF, or `width` for a replay.

### The replay stopped at a step

The reply names the step and the error, and it has a screenshot. Some common causes:

- An element has a new name or a new place. Fix the `action` of the step, and run the plan again.
- The step depends on data from an earlier run. Add steps that make the data, or use `{{unique}}`.
- The page shows data that changes. Add a `mock` step with fixed data.

### "Walkthrough cannot replay the run"

Some actions in the run have no stable selector. For example, the agent clicked one of many elements that look the same, and the element has no id, test id, or name. The reply lists the steps. Add an exact `action` to each of these plan steps, and run the plan again.

### "A run is going" or "A video is recording"

A replay needs the browser for itself. Finish the run with `run_finish`, or stop the video with `video` action `stop`. Then replay again.
