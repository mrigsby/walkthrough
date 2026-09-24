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
| `baseUrl` | No | The start page. It replaces `baseUrl` from `config.yaml` for this plan. |
| `mode` | No | `interactive`, `checkpoints` (default), or `autonomous`. See [Run modes](#run-modes). |
| `steps` | Yes | The list of steps. |
| `device` | No | Screen preset: `desktop`, `laptop`, `tablet`, `mobile`, or a Puppeteer device name, such as `Pixel 5`. |
| `colorScheme` | No | `light` or `dark`. |
| `network` | No | `normal`, `slow-3g`, `fast-3g`, `slow-4g`, `fast-4g`, or `offline`. |
| `session` | No | A saved login, from the `session` tool. The run starts logged in. |

## Step keys

| Key | Required | What it does |
| --- | --- | --- |
| `do` | Yes | What to do, in plain words. |
| `id` | No | A short id, like `open-cart`. Use lowercase letters, numbers, and dashes. Reports use it. |
| `expect` | No | What you should see after the step. Make it specific, such as "The total is $10.00". |
| `checkpoint` | No | In `checkpoints` mode, the developer confirms this step in the panel. |
| `action` | No | An exact action, so the agent does not have to guess. See below. |
| `screenshot` | No | Save a screenshot after the step. |
| `visual` | No | Compare a screenshot with the saved baseline after the step. See [Visual checks](#visual-checks). |

### Write a good `expect`

- Say what a person can check in a few seconds: exact text, numbers, or what is visible.
- Put exact text in quotes, such as `The page says "Order placed"`. An [exported script](sharing.md#run-tests-in-ci) checks quoted text and amounts such as `$30.00`. Other words become a comment to check by hand.

## Exact actions

Use one key in `action`:

- `navigate: /cart` opens a path or a full URL.
- `click`, `dblclick`, `hover`, `check`, `uncheck`, `scroll` take a target: `{ role: button, name: Checkout }` or `{ selector: "#checkout" }`.
- `fill` and `select` take a target and a `value`: `{ role: textbox, name: Email, value: a@b.com }`.
- `press` takes a `value`, such as `Enter`, and an optional target.
- `upload` takes a target and `files`: `{ selector: "#avatar", files: [fixtures/photo.png] }`.
- `wait: Order placed` waits for that text on the page.

For passwords, write `value: "{{secret:NAME}}"`. The value comes from `.walkthrough/.env`, and the agent never sees it.

## Run modes

| Mode | Who checks each step |
| --- | --- |
| `interactive` | You confirm every step in the panel. |
| `checkpoints` | You confirm the steps with `checkpoint: true`. The agent checks the rest. |
| `autonomous` | The agent checks every step. It saves a screenshot when a step fails. |

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

## Saved logins

To start runs logged in:

1. Log in once in the test browser.
2. Ask the agent to save the session, for example "save this login as admin".
3. Add `session: admin` to a plan.

Saved logins go in `.walkthrough/sessions/`. Git does not track that folder, and only your user account can read the files. Anyone with the file can log in as that user, so do not share it. Apps that keep their login in IndexedDB need a new login each time.

## Results and reports

Each run gets a folder in `.walkthrough/runs/`. It holds:

- `run.json`: the result of each step. Walkthrough saves it after every step, so a crash does not lose the finished steps.
- `screenshots/`: the screenshots from the run.
- `report.md`: a report for a code editor, a pull request, or an issue.
- `report.html`: one file with the screenshots inside. Open it in any browser.

If a run ends early, Walkthrough still writes the reports and marks the run "Incomplete".

## Editor help

The first line of each plan points to `plan.schema.json`. In VS Code, install the YAML extension from Red Hat. It then gives autocomplete and marks mistakes as you type.
