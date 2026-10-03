# Presentations

Walkthrough can show your app to an audience as a live demo. It plays a test plan step by step in an audience window, and it waits for you before each step. You control it from a presenter window with your notes, the time, and a chat with the agent. When the talk ends, you get a handout and, if you want, a video.

A presentation is a normal plan with some more keys, so the same plan still runs as a test or a video.

## Quick start

1. Start the demo shop: `npm run demo`.
2. In Claude Code, type `/walkthrough:present checkout-tour`.
3. The agent rehearses the plan first: it runs every step as a test. Then a new Chrome opens with two windows.
4. Drag the **audience window** to the projector, or click **Other screen** in the presenter window. In a video call, share only the audience window.
5. Click **Start** in the presenter window, or press the right arrow.
6. Before each step, the presentation waits. Talk, then press the right arrow to play the step.
7. At the end screen, click **Close presentation**. The agent tells you where the handout is.

## What the audience sees

The audience window is the app, in a window with no tabs and no address bar. Walkthrough draws these on top of the app:

- **Title and end screens.** An image or a text slide shows before the start and after the last step.
- **Slides.** A step can show a full-window slide, such as an agenda.
- **Spotlight.** Before a step, the page goes dark except the element of the next action.
- **Zoom.** Before a step, a bigger picture of the next element can show in the middle of the screen.
- **Pointer.** A pointer moves to each element and shows a ripple on each click. Typed text appears one character at a time.
- **Captions.** The caption of the step shows at the bottom.
- **Blank screen.** Press **B** to show a black screen, and press it again to show the app.
- **Privacy blur.** The plan's `mask` selectors blur parts of the page, such as customer names. Fields with secrets show dots.

`pageZoom` makes the page bigger, like Chrome's own zoom, so people at the back of the room can read it. The page still fills the window. The audience window has no scrollbars, so a slide covers the whole window.

## The presenter window

The presenter window is for you only. It shows:

- The plan name, the environment and its address, the step number, the time against the time budget, and the clock.
- The current step and its time. The time turns amber near the step's budget and red after it.
- Your notes for the step. **A-** and **A+** change the text size.
- The next step.
- A live picture of the audience screen.
- The list of steps, with a check mark on each step that played. Click a step to jump to it.
- The chat with the agent.

### Controls and keys

| Control | Keys | What it does |
| --- | --- | --- |
| **Start** | Right arrow, Space, Page Down | Starts the presentation from the title screen. |
| **Continue** | Right arrow, Space, Page Down | Plays the next step. |
| **Back** | Left arrow, Page Up | Goes back to the step before. |
| **Skip** | | Goes on without this step. |
| **Go to end** | | Shows the end screen. |
| **Blank** | B or the period key | Shows a black screen on the audience window, and the app again. |
| **Title** | | Shows the title screen again, for example during questions. |
| **Fullscreen** | | Turns fullscreen on and off for the audience window. |
| **Other screen** | | Moves the audience window to another display, in fullscreen. |
| **Close presentation** | | At the end screen: closes both windows and writes the handout. |

The keys work in both windows, so a presentation clicker works too. Most clickers send Page Down and Page Up. These keys always go to the presentation, also while you type in the chat. After you send a question, the arrow keys work again. Press Escape to leave the chat box without sending.

The keys in the audience window go to the presentation, not to the app. Walkthrough counts only real key presses and real clicks, so a script in the page cannot move the presentation.

### Jump and back

- **Back** and a jump to an earlier step start the app again in a new login. The steps before the target run at full speed behind a "One moment" screen. `{{unique}}` gets a new value, so the app makes new data, such as a new order.
- A jump to a later step runs the steps between at full speed behind the "One moment" screen.

### When a step does not work

The presenter window shows the error, with three choices:

- **Retry** plays the step again from the action that failed. Actions before it in the step do not run again, so a form is not sent two times.
- **Skip** goes on with the next step.
- **I will do it by hand** lets you use the app in the audience window. The keys go to the app then. Click **Continue** when you are done.

The agent hears about the failed step too. It looks at the page and sends a short note to the chat with the likely cause.

## The chat

You can ask the agent about the app during the talk, such as "Where does the cart count come from?". Type the question in the chat box of the presenter window and press Enter. The agent answers in 1 to 3 short sentences. It can look at the page and read the project code, but it cannot change the page.

How it works:

- The Claude Code session listens for questions during the whole talk, so the terminal is busy. Leave it open.
- The chat shows **Claude is listening**, **Claude is thinking**, or **Claude is not listening now**. A question waits until the agent listens again.
- If you press Escape in the terminal, the agent stops listening. The presentation goes on. Ask the agent to listen again.
- **Show on screen** puts an answer at the bottom of the audience screen for 12 seconds.

## Write a presentation plan

Start from a plan that works as a test. `/walkthrough:present` can write one for you. Then add a `presentation` block, notes, and slides:

```yaml
# yaml-language-server: $schema=../plan.schema.json
name: Checkout tour
environments: [development, staging]
vars: { shopper: Demo Shopper }
presentation:
  title: { image: .walkthrough/slides/title.svg }
  end: { image: .walkthrough/slides/end.svg }
  timeBudget: 5m
  pageZoom: 1.25
  record: true
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: "1. Add a mug\n2. Check out" }
    notes: Welcome. This is the build from today.

  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug
    action: { click: { selector: '[data-add="mug"]' } }
    caption: Add a mug to the cart
    zoom: 2
    timeBudget: 45s
    notes: |
      The cart count updates without a page load.
      - Ask: who has used the old cart?

  - id: enter-name
    do: Type the name
    action: { fill: { role: textbox, name: Full name, value: "{{var:shopper}}" } }
    pause: false
```

Each step that does something needs an exact `action`, so the presentation can play it. See [Exact actions](plan-format.md#exact-actions).

### `presentation` keys

| Key | What it does |
| --- | --- |
| `title` | A slide before the start. It shows until you click **Start**. |
| `end` | The last screen. Without it, the end screen shows the plan name and "Questions?". |
| `pause` | `before` (default): wait for you before each step. `none`: go on by itself. A step's `pause` wins. |
| `pace` | How fast the pointer moves and the text types: `slow`, `normal` (default), or `fast`. |
| `pointer` | Show the pointer and the click ripple. Default: `true`. |
| `spotlight` | Dim the page except the next element during a pause. Default: `true`. |
| `captions` | Show the caption of each step. Default: `true`. |
| `window` | The size of the audience window, like `{ width: 1920, height: 1080 }`. Default: 1280 x 800. |
| `pageZoom` | Make the page bigger, like `1.25`. |
| `fullscreen` | Start the audience window in fullscreen. |
| `device` | Use the plan's `device`, such as `mobile`, on the audience screen. By default, the page fills the window. |
| `mirror` | Show the live picture of the audience screen in the presenter window. Default: `true`. |
| `timeBudget` | The time for the whole talk, like `10m`. |
| `mask` | CSS selectors of things to blur, like `['.customer-name', '[data-email]']`. |
| `record` | Record the audience screen as a video: `true`, or `{ format, path }`. See [After the talk](#after-the-talk). |
| `kiosk` | Run with no presenter: `{ holdSeconds, loop, loops }`. See [Kiosk mode](#kiosk-mode). |

### Step keys

| Key | What it does |
| --- | --- |
| `notes` | Your notes for the step. Only the presenter window shows them. They can have **bold**, *italic*, `code`, and lists that start with `- `. |
| `caption` | The text that the audience reads at the bottom. Without it, they see `do`. |
| `slide` | A slide before the step's action, or the whole step when it has no action. A test run skips a step that is only a slide. |
| `pause` | `false` plays the step without a stop, such as the next field of a form. |
| `spotlight` | `false` turns the spotlight off for this step. |
| `zoom` | Show the next element this many times bigger during the pause, from `1.25` to `4`. |
| `timeBudget` | The time for this step, like `45s`. |

A slide is an image, or a title with text:

```yaml
slide: { image: .walkthrough/slides/architecture.png, fit: contain, background: "#000000" }
slide: { title: Today, text: "Three things to show", background: "#111827", color: "#ffffff" }
```

Images can be PNG, JPEG, WebP, GIF, or SVG, up to 15 MB. They must be in the project folder. Walkthrough does not show images from hidden folders, except `.walkthrough`, and never from `.walkthrough/sessions` or `.walkthrough/runs`. We suggest `.walkthrough/slides/`.

### Tips

- Keep notes short: one to three lines that you can read at a glance.
- Write a caption of a few words for each step that the audience should follow.
- Use `zoom` for small buttons and fields.
- Use `pause: false` for steps that belong together, such as the fields of one form.
- Use `{{unique}}` for data that must be new each time, such as an email address. The rehearsal makes the data one time, and the presentation makes it again.
- Use test data, and `mask` for anything personal.

## Rehearsals

The presentation plays a rehearsal: a test run of the plan in which every step passed. The rehearsal checks that the app works today, and it gives each action a stable selector.

- `/walkthrough:present` rehearses for you when there is no good rehearsal. The agent runs the plan in `autonomous` mode.
- A rehearsal from the last 12 hours, on the same environment, counts. A change to the actions, the checks, the vars, or the settings of the plan, such as its `device`, needs a new rehearsal. A change to notes, slides, captions, pauses, or times does not.
- You can rehearse on staging and present on production. Ask the agent to use the staging run. The presentation goes to the same pages on the other environment.

## Environments

A presentation runs on the environment that you name, such as `/walkthrough:present checkout-tour on staging`. The plan's `environments` key can limit where it runs. See [Environments](environments.md).

On a protected environment, such as production, the presenter window asks **Present on Production?** before the app opens. The audience sees only the title until you click **Present here**. The agent cannot confirm it for you.

## After the talk

When the presentation ends, Walkthrough writes a handout in the folder of the rehearsal run:

```text
.walkthrough/runs/<rehearsal>/presentations/<date and time>-<environment>/
  presentation.html   The handout, with pictures. It plays the video.
  presentation.md     The same handout in Markdown.
  frames/             A picture of the audience screen after each step.
  presentation.mp4    The video, if the plan has record.
```

The handout shows the environment and its address, the date, and the length of the talk. For each step, it shows a picture, your notes, and the time on the step. At the end, it lists the questions and answers from the chat. Secrets in the chat and the notes show as `****`.

With `record`, the video shows the audience screen. Steps play at normal speed, long pauses become short ones, and the "One moment" screens of a jump are cut. `record: { format: gif, path: docs/images/tour.gif }` picks the format and also saves the video to a file. The default format comes from `video.runFormat` in `config.yaml`. See [Videos](video.md).

## Kiosk mode

For a screen at a booth, a kiosk presentation runs with no presenter. Each step and slide shows for `holdSeconds`, and `loop` starts again at the title after the end screen.

```yaml
presentation:
  kiosk: { holdSeconds: 6, loop: true }
```

You can also ask for kiosk mode when you start: `/walkthrough:present checkout-tour kiosk`. Each loop starts in a new login with a new `{{unique}}` value. Press Escape in the audience window to stop. A kiosk has no presenter window, no chat, no recording, and no handout. On a protected environment, the MCP client asks you to confirm, or `UIWALK_ALLOW_PROTECTED` names the environment.

## While a presentation is going

- The agent can use only tools that read: `snapshot`, `read`, `screenshot`, `logs`, `network`, `runs`, `plan`, `issue_draft`, `export_script`, `environment` (not `use`), and `tabs` with action `list`. Other tools wait until the end, so nothing changes what the audience sees by mistake.
- The presentation uses a Chrome of its own. If Walkthrough is connected to your own Chrome (`browser_open` with `attach`), close it with `browser_close` first.
- Closing the audience window ends the presentation. Closing the presenter window does not. Ask the agent to open it again.

## Troubleshooting

| Problem | What to do |
| --- | --- |
| "There is no good rehearsal" | Let the agent rehearse, or run the plan yourself with `/walkthrough:run <plan> autonomous`. |
| A step has "no stable selector" | Give the plan step an exact `action`, and rehearse again. |
| The keys do nothing | Click in the presenter window or the audience window first, so it has the keys. In the chat box, press Escape. |
| **Other screen** says that Chrome did not list the screens | Drag the audience window to the other screen, and click **Fullscreen**. |
| The chat says **Claude is not listening now** | Ask the agent in the terminal to listen again. |
| A slide image does not show | Check the path and the file type. `present` lists the slides that it cannot show. |
