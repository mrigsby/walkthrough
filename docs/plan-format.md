# Test plan format

A test plan is a YAML file in `.walkthrough/plans/`. The agent reads the plan, does each step in the browser, and records the result.

## Example

```yaml
# yaml-language-server: $schema=../plan.schema.json
name: Checkout flow
description: Add an item and check the total.
mode: checkpoints
steps:
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
    expect: The cart lists the Coffee Mug ($10.00).

  - id: check-total
    do: Read the cart total
    expect: The total is $10.00.
    checkpoint: true
    screenshot: true
```

## Plan keys

| Key | Required | What it does |
| --- | --- | --- |
| `name` | Yes | The name of the test. Reports use it. |
| `description` | No | A short note about the test. |
| `baseUrl` | No | The start page: a full URL, or a path like `/admin` on the site of the environment. A full URL on the site of another environment moves to the environment in use. |
| `environment` | No | The environment to run in, such as `staging`, when the tool call and the session do not choose one. See [Environments](environments.md). |
| `environments` | No | The only environments this plan may run in, such as `[development, staging]`. Use it for plans that make data. |
| `vars` | No | Values for `{{var:NAME}}` in this plan, such as `{ shopper: Demo Shopper }`. An environment can change them. |
| `mode` | No | `interactive`, `checkpoints` (default), or `autonomous`. See [Run modes](#run-modes). |
| `steps` | Yes | The list of steps. An item can also be `include: <plan>`. See [Reusable plan parts](#reusable-plan-parts). |
| `device` | No | Screen preset: `desktop`, `laptop`, `tablet`, `mobile`, or a Puppeteer device name, such as `Pixel 5`. |
| `colorScheme` | No | `light` or `dark`. |
| `network` | No | `normal`, `slow-3g`, `fast-3g`, `slow-4g`, `fast-4g`, or `offline`. |
| `emulate` | No | More settings for every tab, such as `{ timezone: Europe/Berlin, cpu: 4 }`. It takes the same keys as the `emulate` tool. `device`, `colorScheme`, and `network` above win over the same keys here. |
| `session` | No | A saved login, from the `session` tool. The run starts logged in. |
| `screenshotDir` | No | The folder for step screenshot paths, from the project folder, such as `docs/images/help`. See [Screenshots for docs](#screenshots-for-docs). |
| `accessibility` | No | Settings for accessibility checks: `report`, `standard`, and `checks`. See [Accessibility checks](#accessibility-checks). |
| `lighthouse` | No | Settings for the Lighthouse steps: `device`, `categories`, and `report`. See [Lighthouse flows](#lighthouse-flows). |
| `video` | No | Record the whole run as a video: `true`, or `{ format, path, showPanel, captions, mask }`. See [Videos](#videos). |
| `panel` | No | Labels, buttons, and the "What's next" part of the panel for every step, and `corner`, `progress`, and `shortcuts`. See [The panel](#the-panel). |
| `snippets` | No | Text that the developer can copy, like terminal commands, for `{{copy:name}}` in panel text. See [Snippets](#snippets). |
| `browser` | No | Browser settings for this plan, like `{ language: de-DE, devtools: true }`. They win over `config.yaml`. See [Browser settings](#browser-settings). |
| `presentation` | No | Settings to play the plan as a live presentation, such as `title`, `end`, `timeBudget`, and `record`. See [Presentations](#presentations). |

## Step keys

| Key | Required | What it does |
| --- | --- | --- |
| `do` | Yes | What to do, in plain words. A card step does not need it. |
| `id` | No | A short id, like `open-cart`. Use lowercase letters, numbers, and dashes. Reports use it. |
| `expect` | No | What you should see after the step. Make it specific, such as "The total is $10.00". It can have lists, check lists, and code. See [Text in the panel](#text-in-the-panel). |
| `next` | No | What comes after this step. The panel shows it under "What's next". |
| `panel` | No | Labels and buttons for this step only. See [The panel](#the-panel). |
| `snippets` | No | Snippets for this step only. See [Snippets](#snippets). |
| `expectImage` | No | An image of what the page should look like, such as `docs/images/cart.png`. See [Reference images](#reference-images). |
| `command` | No | A terminal command that the step needs, such as `npm run db:seed`. See [Terminal commands](#terminal-commands). |
| `card` | No | Show a card, like a start or end message, and wait for the developer. See [Cards](#cards). |
| `checkpoint` | No | In `checkpoints` mode, the developer confirms this step in the panel. |
| `action` | No | An exact action, so the agent does not have to guess. See below. |
| `screenshot` | No | Save a screenshot after the step. `true` saves it with the run. A path saves it to that exact file. See [Screenshots for docs](#screenshots-for-docs). |
| `visual` | No | Compare a screenshot with the saved baseline after the step. See [Visual checks](#visual-checks). |
| `a11y` | No | Check accessibility after the step. `true`, or `{ selector, checks }`. See [Accessibility checks](#accessibility-checks). |
| `emulate` | No | Settings for the tab of this step, such as `{ device: mobile, orientation: landscape, locale: de-DE }`. The agent sets them before the step. See [Tabs and logins](#tabs-and-logins). |
| `cookies` | No | Cookie checks after the step, such as `[{ name: session, httpOnly: true }]`. See [Cookie checks](#cookie-checks). |
| `mock` | No | Mock rules to add before the step, or `off` to remove all rules. See [Mocked requests](#mocked-requests). |
| `lighthouse` | No | Measure the step with Lighthouse: `navigation`, `timespan`, or `snapshot`. See [Lighthouse flows](#lighthouse-flows). |
| `caption` | No | The text that viewers see at the bottom of a video during this step. Without it, the video shows `do`. See [Videos](#videos). |
| `notes` | No | Notes for the presenter of a presentation. Only the presenter window shows them. See [Presentations](#presentations). |
| `slide` | No | In a presentation, a full-window slide before the action, or the whole step when it has no action. A test run skips a step that is only a slide. |
| `pause` | No | In a presentation, `false` plays the step without waiting for the presenter. |
| `spotlight` | No | In a presentation, `false` turns off the spotlight on the next element. |
| `zoom` | No | In a presentation, show the next element this many times bigger during the pause, from `1.25` to `4`. |
| `timeBudget` | No | In a presentation, the time for this step, like `45s`. |

### Write a good `expect`

- Say what a person can check in a few seconds: exact text, numbers, or what is visible.
- Put exact text in quotes, such as `The page says "Order placed"`. An [exported script](sharing.md#run-tests-in-ci) checks quoted text and amounts such as `$30.00`. Other words become a comment to check by hand.

## The panel

The panel shows each step that the developer confirms. A plan can change its labels, its buttons, and the "What's next" part. A step can change them for itself, and its settings win.

```yaml
panel:
  labels: { did: What I did, expect: What you should see, next: What's next }
  next: { collapsed: true, auto: true }
  buttons:
    pass: { label: Looks good, color: "#15803d" }
    retry: { show: false }
  corner: top-right
steps:
  - id: seed
    do: Fill the test database
    command: npm run db:seed
    expect: The script prints "Done".
    next: The agent opens the admin page.
    panel:
      labels: { did: Setup, expect: Your part }
      buttons: { pass: { label: Done } }
```

- `labels` names the parts of the panel: `did`, `expect`, `next`, and `command`. An empty label (`""`) shows no label.
- `next` is the "What's next" part. It starts closed, unless `collapsed: false`. With `auto: true`, a step without its own `next` shows the `do` text of the step after it, or "This is the last step."
- `buttons` sets the text and the color of `pass`, `bug`, `skip`, `retry`, and `stop`. The text color follows the button color, so it is easy to read. `show: false` hides `bug`, `skip`, or `retry`.
- `corner` is where the panel starts: `bottom-right` (default), `bottom-left`, `top-left`, or `top-right`.
- `progress: false` hides the list of all steps. The list opens with the button in the panel header.
- `shortcuts: false` turns off the keys that answer a question. See [Answer in the panel](#answer-in-the-panel).
- During a run, the agent gives only the step id and what it did. Walkthrough takes the title, `expect`, and the step number from the plan. The agent can also change the panel for one question.

### Text in the panel

`expect`, `next`, the content of a card, and the help of a snippet can use a small part of Markdown:

- `- item` or `* item` for a list, and `1. item` for a numbered list
- `- [ ] item` and `- [x] item` for a check list. The developer can tick the boxes. A box that is not ticked asks for a second click on Pass. The answer and the reports show the ticks.
- three backticks before and after a code block. Each code block gets a Copy button.
- `**bold**`, `*italic*`, and `` `code` ``
- `{{copy:name}}` for a snippet

Raw HTML shows as text, and links show as text too. Walkthrough removes secret values from all panel text.

### Snippets

A snippet is text that the developer can copy with one click, like a terminal command. Put `{{copy:name}}` in panel text. The panel shows the snippet with a Copy button, and with a "?" button when it has `help`.

```yaml
snippets:
  seed: npm run db:seed
  reset:
    code: npm run db:reset -- --env=test
    help: |
      Clears the **test** database.
      - It does not change other environments.
steps:
  - id: prepare
    do: Ask the developer to reset and seed the database
    expect: |
      Run {{copy:reset}}, then {{copy:seed}}.
```

- A plan has `snippets` for all steps. A step can add its own, and they win over the plan's.
- Each `{{copy:name}}` needs a snippet. A missing one is a plan error.
- A snippet cannot hold a `{{secret:NAME}}`, because Walkthrough never copies secrets.
- The "?" button opens a window in the middle of the page with the snippet, its Copy button, and the help.
- The Copy button uses the clipboard of the browser. On a page that blocks it, the panel uses another way. If a page script could change the text, the panel says "Check the text before you paste it."

### Reference images

A step can show an image of what the page should look like. The panel shows it small under "What you should see". A click shows it large.

```yaml
  - id: open-cart
    do: Open the cart
    expect: The cart looks like the picture.
    expectImage: docs/images/cart.png
```

The image must be a `.png`, `.jpg`, `.jpeg`, or `.webp` file of up to 1.5 MB, in the project folder.

## Cards

A card step shows a heading and text, like a start message or an end message, and waits for the developer. It does nothing in the browser.

```yaml
steps:
  - id: welcome
    card:
      heading: Checkout test
      subheading: About 5 minutes
      content: |
        This plan checks:
        - the cart total
        - the coupon
      size: modal
    panel: { buttons: { pass: { label: Start }, stop: { label: Cancel } } }

  # ... the test steps ...

  - id: done
    card: { heading: Done, content: Every step passed., when: passed }
  - id: done-with-problems
    card: { heading: Done, with problems, content: The report lists them first., when: problems }
```

- `heading` is required. `subheading` and `content` are optional. `content` can use [Text in the panel](#text-in-the-panel).
- `size: panel` (default) shows the card in the panel. `size: modal` shows a big card in the middle of the page. It stays until the developer answers.
- `when: passed` shows the card only when no step so far had a bug or failed. `when: problems` shows it only when one did. Otherwise the run records the card as "Not shown".
- A card has Pass and Stop buttons. `panel.buttons` can show `bug` and `skip` with `show: true`, and change the text and colors.
- A card waits for the developer in every mode, also in `autonomous` mode.
- A card step cannot have `action`, `expect`, `screenshot`, or other keys that test the page.
- Reports show a card as "Card: Seen", "Card: Not shown", or "Card: Stopped", and leave cards out of the result counts. Presentations, replays, videos, and exported scripts skip cards.

## Answer in the panel

- **Pass**, **Bug**, **Skip**, **Retry**, and **Stop** answer a question. Bug needs notes.
- **Retry** asks the agent to do the step again. The report keeps the earlier try and its notes.
- **Point at the problem** lets the developer click the element of a bug. The app does not get that click. Esc stops pointing. On Bug, the screenshot puts a red box on that element, and Walkthrough saves its styles and CSS rules next to the screenshot.
- Keys: Option+Shift (Alt+Shift on Windows and Linux) with P, B, S, R, or X answer Pass, Bug, Skip, Retry, or Stop. The app does not get these keys. The confirm question of a protected environment takes no keys.
- The list button in the panel header shows every step of the run, with its result.

## Reusable plan parts

A step item `include: <plan>` puts the steps of another plan in that place. Use it for steps that many plans share, like a login.

```yaml
name: Checkout as a customer
steps:
  - include: login
  - id: open-cart
    do: Open the cart
    action: { navigate: /cart }
```

- Use the name of a plan in `.walkthrough/plans`, such as `login`. A path does not work.
- The part is a normal plan, so it still runs alone.
- Parts can include parts, up to three levels.
- The `vars` of the part are defaults. The outer plan's `vars` win. The part keeps its own `snippets` and `screenshotDir` for its own steps. Other plan keys of the part, like `mode`, do not count.
- Two steps cannot have the same id, also when they come from different files. A problem in a part names the file and the line, such as `login.yaml steps[0].do`.

## Terminal commands

A step can need a command in a terminal, like a script that fills the database.

```yaml
  - id: seed
    do: Fill the test database
    command:
      run: npm run db:seed -- --env=test
      help: Fills the test database with sample products.
    expect: The script prints "Done".
```

- `command` is the text of the command, or `{ run, help }`.
- The panel shows the command with a Copy button, and a "?" button for its help.
- Before the step, the agent asks the developer in chat. Should the agent run the command with its own tool, or will the developer run it? Claude Code asks the developer to approve a command that the agent runs.
- Walkthrough itself never runs commands.
- A command cannot hold a `{{secret:NAME}}`.
- Reports show the command. Exported scripts and replays name it, but do not run it.

## Browser settings

A plan can set how Chrome runs in a `browser` block. The plan wins over the `browser` block of `config.yaml`, key by key.

```yaml
browser:
  window: { width: 1440, height: 900 }
  language: de-DE
  downloads: true
  devtools: { dock: window }
```

See [Browser settings](config.md#browser) for all keys. A run that needs other launch settings than the open browser starts a new browser, and says so.

## Exact actions

Use one key in `action`:

- `navigate: /cart` opens a path or a full URL.
- `click`, `dblclick`, `hover`, `check`, `uncheck`, `scroll` take a target: `{ role: button, name: Checkout }` or `{ selector: "#checkout" }`.
- `fill` and `select` take a target and a `value`: `{ role: textbox, name: Email, value: a@b.com }`.
- `press` takes a `value`, such as `Enter`, and an optional target.
- `upload` takes a target and `files`: `{ selector: "#avatar", files: [fixtures/photo.png] }`.
- `wait: Order placed` waits for that text on the page.
- `newTab`, `switchTab`, and `closeTab` open, change, and close tabs. See [Tabs and logins](#tabs-and-logins).

For passwords, write `value: "{{secret:NAME}}"`. The value comes from `.walkthrough/.env`, and the agent never sees it.

For test data that is different in each environment, such as a test user or a product, write `{{var:NAME}}`, such as `value: "{{var:shopper}}"`. The value comes from `vars` in the plan, in `config.yaml`, or in the environment. See [Values for each environment](environments.md#values-for-each-environment).

For data that must be new each time, put `{{unique}}` in a value or a path, such as `value: "demo+{{unique}}@example.com"`. It becomes a short value, such as `k3x9p2`, that stays the same for the whole run. Each run gets a new value, so a flow that makes an account or an order can run again. `run_start` shows the value, and exported scripts make a new one each time.

## Tabs and logins

A plan can use more than one tab, and more than one login. Use this to test two users at the same time, such as a customer and an admin.

```yaml
steps:
  - id: guest-cart
    do: Open the cart as a guest in a new tab
    action: { newTab: { name: guest, isolated: true, url: /cart } }
    emulate: { device: mobile }
    expect: The page says "Your cart is empty."
  - id: open-help
    do: Click Help in the guest tab
    action: { click: { role: link, name: Help } }
  - id: help-tab
    do: Use the Help tab that opened
    action: { switchTab: { tab: newest, name: help } }
  - id: back
    do: Go back to the first tab
    action: { switchTab: main }
```

- `newTab` takes `url`, `name`, `isolated`, and `session`. `isolated: true` gives the tab a new login of its own. A name, such as `isolated: admin`, gives it a login that tabs with the same name share.
- `switchTab` takes a tab name, such as `main` or `guest`. The first tab is `main`. `{ tab: newest, name: help }` uses the tab that opened last, such as a popup, and names it.
- `closeTab` takes a tab name.
- `emulate` on a step changes only the tab of that step.

Record mode writes these steps when you use more than one tab. Exported scripts repeat the tabs, the logins, and the settings.

## Run modes

| Mode | Who checks each step |
| --- | --- |
| `interactive` | You confirm every step in the panel. |
| `checkpoints` | You confirm the steps with `checkpoint: true`. The agent checks the rest. |
| `autonomous` | The agent checks every step. It saves a screenshot when a step fails. Cards still wait for you. |

You can change the mode when you ask for a run, for example: "Run the checkout plan in autonomous mode."

## Record a plan

Instead of writing a plan by hand, run `/walkthrough:record`. Use the app as usual, and the panel records each click and each field that you type in. When you click **Stop recording**, the agent shows you a draft plan to review and save.

- Password fields become `{{secret:NAME}}`. Walkthrough never records their values.
- After you type a private value that is not a password, click **Mark last field as secret**.
- Click **Add expectation** to say what the page should show at that point.
- Record mode does not record clicks inside frames, such as a payment form, or answers to dialogs. Add those steps by hand.
- An upload step points to `fixtures/<file name>`. Put the file there, or fix the path.

## Visual checks

A step with `visual: true` compares the page with a baseline screenshot.

- The first check saves the baseline in `.walkthrough/baselines/<plan>/`. If your team wants to share them, commit these files.
- Each baseline is for one screen preset and one operating system, because fonts look different on each system.
- A later check saves a diff image, with the changed pixels in red. Any real change fails the check. Edge noise from font smoothing does not.
- The agent asks you whether the change is expected. If you say yes, it saves the new baseline.

## Accessibility checks

A step with `a11y: true` checks the page for accessibility problems after the step. The results go into the run report, and into the accessibility report.

```yaml
name: Checkout accessibility
accessibility:
  report: true
  standard: wcag22aa
  checks: { keyboard: true, screenshots: false }
steps:
  - do: Open the checkout page
    action: { navigate: /checkout }
    a11y: true
  - do: Open the payment form
    a11y: { selector: "#payment", checks: [frames] }
```

- `accessibility.report: true` asks the agent to write the accessibility report when the run ends.
- `accessibility.standard` is `wcag2a`, `wcag2aa`, `wcag21aa`, or `wcag22aa`.
- `accessibility.checks` turns checks on or off: `keyboard`, `darkMode`, `reflow`, `frames`, and `screenshots`. Checks that it does not name keep the setting from `config.yaml`.
- A step can name its own `checks` and a `selector`. The selector limits axe-core only. The other checks look at the whole page.

See [Accessibility reports](accessibility.md).

## Screenshots for docs

Use a plan to make the screenshots for help pages or other docs. Each step can save its screenshot to an exact file. Walkthrough replaces the file if it exists.

```yaml
name: Help screenshots
mode: autonomous
device: desktop
colorScheme: light
screenshotDir: docs/images/help
steps:
  - id: login
    do: Log in as the help user
    action: { fill: { selector: "#password", value: "{{secret:HELP_PASSWORD}}" } }

  - id: cart
    do: Open the cart
    action: { navigate: /cart }
    screenshot: cart.png

  - id: cart-total
    do: Show the cart total
    screenshot: { path: cart-total.png, selector: "#total" }

  - id: settings
    do: Open the settings
    action: { navigate: /settings }
    screenshot: { path: settings.png, fullPage: true }
```

- `screenshot` can be a path, or an object with `path`, `selector` (capture only this element), and `fullPage` (capture the whole page).
- The path must end in `.png`, `.jpg`, `.jpeg`, or `.webp`. The file type comes from the extension.
- `screenshotDir` goes in front of each relative path. Without it, paths start at the project folder.
- Files must be in the project folder, and not in a hidden folder such as `.git`. To save to another folder, add it to `screenshotRoots` in `config.local.yaml`. See [Settings](config.md).
- Walkthrough checks the paths when the run starts, so a bad path stops the run before the browser opens.
- Set `device` and `colorScheme`, so the screenshots have the same size and colors each time.

To make the screenshots again without an agent, export the run as a script. `SHOT=cart` makes only one of them again. See [Make screenshots again](sharing.md#make-screenshots-again).

## Mocked requests

A step can answer requests with your own data, block them, or delay them. Use this to test an error state or an empty list without changing the server.

```yaml
  - id: stock-down
    do: Check the stock of the mug when the stock service is down
    mock:
      - { url: /api/stock, status: 503, json: { error: Service down } }
    action: { click: { selector: '[data-stock="mug"]' } }
    expect: The page says "Could not check stock. Try again later."
  - id: stock-up
    do: Check the stock again when the service works
    mock: off
    action: { click: { selector: '[data-stock="mug"]' } }
```

A rule takes the same keys as the `intercept` tool: `url` or `urlRegex`, and `method`, `type`, `tab`, `status`, `json`, `body`, `headers`, `contentType`, `delayMs`, `block`, and `times`. Rules stay on for the next steps. `mock: off` removes all rules. The report marks each step that used a rule, and exported scripts repeat the rules.

## Cookie checks

A step can check cookies after it runs. The agent calls the `storage` tool with the step id, and Walkthrough compares the cookies. It never shows their values.

```yaml
  - id: log-in
    do: Log in as demo
    cookies:
      - { name: session, httpOnly: true, sameSite: Lax }
  - id: log-out
    do: Click "Log out"
    cookies:
      - { name: session, exists: false }
```

A check has a `name`, and any of these: `exists` (`false` means the cookie must be gone), `value`, `contains`, `httpOnly`, `secure`, and `sameSite` (`Strict`, `Lax`, or `None`). `value` and `contains` can use `{{secret:NAME}}` and `{{unique}}`. Exported scripts check the cookies too.

## Lighthouse flows

A plan can measure a user flow with Lighthouse, like the Lighthouse user flows in DevTools. Install Lighthouse first. See [Lighthouse reports](lighthouse.md).

```yaml
lighthouse:
  device: desktop
  report: true
steps:
  - id: open-shop
    do: Open the shop page
    action: { navigate: / }
    lighthouse: navigation
  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug, then open the cart
    lighthouse: timespan
  - id: open-checkout
    do: Click "Checkout"
    action: { click: { role: button, name: Checkout } }
    lighthouse: snapshot
```

Each step with a `lighthouse` key is one step of the flow:

| Mode | What Lighthouse measures | Categories |
| --- | --- | --- |
| `navigation` | Lighthouse loads the page of the step's `navigate` action, and measures the load. The step needs a `navigate` action. | All |
| `timespan` | What happens while the agent does the step, such as clicks and pages that open after a click. | Performance and Best Practices |
| `snapshot` | The page as it is after the step, such as a form or a dialog. | All |

- `device` is `desktop` or `mobile`, and `categories` lists the categories to check. The defaults come from `config.yaml`.
- `report: true` asks the agent to write `lighthouse.html` when the run ends.
- The run starts in a new browser with an empty profile, so earlier runs do not change the results. To start logged in, add `session` to the plan. When Walkthrough uses your own Chrome, it cannot start a new browser.
- Lighthouse measures the test tab. The tab keeps its screen size, its settings, and its login. For a real mobile check, also set `device: mobile` on the plan, so the screen matches.
- Walkthrough hides its panel while Lighthouse measures. The developer can still answer a question in the panel.
- Lighthouse runs fewer audits for a timespan or a snapshot than for a page load. The reports show them as passed audits, such as `5/6`, and not as a score.
- Walkthrough saves Lighthouse's own flow report as `lighthouse/flow.report.html` in the run folder, after each flow step.

## Videos

A plan can record the whole run as a video. The report plays it.

```yaml
video: { format: mp4, path: docs/videos/checkout.mp4 }
steps:
  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug
    caption: Add the coffee mug to the cart
```

- `video: true` uses the format from `config.yaml`. The object form takes `format` (`mp4`, `webm`, or `gif`), `path` (also save the video to this file), `showPanel`, `captions`, and `mask`.
- `mask` lists CSS selectors of things to blur in the videos and bug clips of the run, like `[".customer-name", "#email"]`. Videos also blur secret values that a page shows. The live page does not change.
- Each step shows its `caption` at the bottom of the video, or its `do` text. Write captions for viewers: short, and about what happens on the screen.
- Walkthrough cuts wait time and question time, hides the panel, hides typed secrets, and blurs secrets that the page shows.
- `run_finish` saves the video as `video/run.<format>` in the run folder.
- For a clean demo video, use `/walkthrough:video`. It records the run again with `video` action `replay`: a new login, an even pace, and a title card. See [Videos](video.md).

## Presentations

A plan can also play as a live demo for an audience, with `/walkthrough:present`. It plays a rehearsal run in an audience window, and it waits for the presenter before each step:

```yaml
presentation:
  title: { image: .walkthrough/slides/title.svg }
  timeBudget: 10m
  record: true
steps:
  - id: agenda
    do: Show the agenda
    slide: { title: Today, text: "1. Add a mug\n2. Check out" }
  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug
    action: { click: { selector: '[data-add="mug"]' } }
    caption: Add a mug to the cart
    notes: The cart count updates without a page load.
    zoom: 2
```

Every step that does something needs an exact `action`. Test runs skip the steps that are only a slide, and they ignore the other presentation keys. See [Presentations](presentations.md) for all keys.

## Saved logins

To start runs logged in:

1. Log in once in the test browser.
2. Ask the agent to save the session, for example "save this login as admin".
3. Add `session: admin` to a plan.

Saved logins go in `.walkthrough/sessions/`, and the logins of other environments go in a folder for each one, such as `.walkthrough/sessions/staging/`. Git does not track that folder, and only your user account can read the files. Anyone with the file can log in as that user, so do not share it. Apps that keep their login in IndexedDB need a new login each time.

## Results and reports

Each run gets a folder in `.walkthrough/runs/`. It holds:

- `run.json`: the result of each step. Walkthrough saves it after every step, so a crash does not lose the finished steps.
- `screenshots/`: the screenshots from the run.
- `report.md`: a report for a code editor, a pull request, or an issue.
- `report.html`: one file with the screenshots inside. Open it in any browser.
- `accessibility.html`, `accessibility.md`, `accessibility.json`: the accessibility report, when the agent writes one. See [Accessibility reports](accessibility.md).
- `a11y/`: screenshots of accessibility problems.
- `lighthouse.html`, `lighthouse.md`, `lighthouse.json`: the Lighthouse report, when the agent writes one.
- `lighthouse/`: Lighthouse's own reports, including `flow.report.html` for a flow.
- `video/`: videos of the run, such as `run.mp4`, bug clips such as `bug-check-total.gif`, and `slideshow.gif`.
- `downloads/`: files that the app downloaded, when the plan sets `browser.downloads`. The reports list them.

If a run ends early, Walkthrough still writes the reports and marks the run "Incomplete".

## Editor help

The first line of each plan points to `plan.schema.json`. In VS Code, install the YAML extension from Red Hat. It then gives autocomplete and marks mistakes as you type.
