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
|---|---|---|
| `name` | Yes | The name of the test. Reports use it. |
| `description` | No | A short note about the test. |
| `baseUrl` | No | The start page. It replaces `baseUrl` from `config.yaml` for this plan. |
| `mode` | No | `interactive`, `checkpoints` (default), or `autonomous`. See [Run modes](#run-modes). |
| `steps` | Yes | The list of steps. |
| `device`, `colorScheme`, `network`, `session` | No | Not ready yet. A later version adds them. |

## Step keys

| Key | Required | What it does |
|---|---|---|
| `do` | Yes | What to do, in plain words. |
| `id` | No | A short id, like `open-cart`. Use lowercase letters, numbers, and dashes. Reports use it. |
| `expect` | No | What you should see after the step. Make it specific, such as "The total is $10.00". |
| `checkpoint` | No | In `checkpoints` mode, the developer confirms this step in the panel. |
| `action` | No | An exact action, so the agent does not have to guess. See below. |
| `screenshot` | No | Save a screenshot after the step. |
| `visual` | No | Not ready yet. A later version adds it. |

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
|---|---|
| `interactive` | You confirm every step in the panel. |
| `checkpoints` | You confirm the steps with `checkpoint: true`. The agent checks the rest. |
| `autonomous` | The agent checks every step. It saves a screenshot when a step fails. |

You can change the mode when you ask for a run, for example: "Run the checkout plan in autonomous mode."

## Results and reports

Each run gets a folder in `.walkthrough/runs/`. It holds:

- `run.json`: the result of each step. Walkthrough saves it after every step, so a crash does not lose the finished steps.
- `screenshots/`: the screenshots from the run.
- `report.md`: a report for a code editor, a pull request, or an issue.
- `report.html`: one file with the screenshots inside. Open it in any browser.

If a run ends early, Walkthrough still writes the reports and marks the run "Incomplete".

## Editor help

The first line of each plan points to `plan.schema.json`. In VS Code, install the YAML extension from Red Hat. It then gives autocomplete and marks mistakes as you type.
