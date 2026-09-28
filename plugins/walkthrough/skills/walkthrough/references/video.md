# Write a plan for a demo video

A demo video comes from a plan. The agent runs the plan once to check it. Then `video` with action `replay` records the run again in a new login, at an even pace. The replay types the text and shows a pointer, captions, and a title card.

## The plan

```yaml
name: Checkout demo
description: A short demo of the checkout, for a video.
mode: autonomous
video: true
steps:
  - id: add-mug
    do: Click "Add to cart" on the Coffee Mug
    action: { click: { selector: '[data-add="mug"]' } }
    caption: Add the coffee mug to the cart
  - id: enter-email
    do: Type a new email address in the Email field
    action: { fill: { role: textbox, name: Email, value: "demo+{{unique}}@example.com" } }
    caption: Enter your email address
```

- `mode: autonomous`: the agent checks each step. Nobody has to answer in the panel.
- `video: true`: the run also records a video. The replay makes the clean one.
- `name`: the title card shows it. Write it for viewers, like "Checkout demo".

## Rules for each step

- Give every step an exact `action`, with one key: `navigate`, `click`, `fill`, `select`, `check`, `press`, and so on. The replay needs a stable selector for each element. Use the role and name from `snapshot`, like `{ role: button, name: Checkout }`. When there is no clear name, use a `selector`.
- One action for each step. Split "type the name, the email, and the address" into three steps.
- Add a `caption` for viewers: 3 to 7 words, about what happens on the screen, like "Add the coffee mug to the cart". Write it in the imperative. Do not name buttons or fields the viewer cannot see.
- Add an `expect` with quoted text or a price where you can, like `The page says "Thank you".` The replay waits for that text, so it does not start the next step too early.

| Write | Not |
| --- | --- |
| `caption: Enter your email address` | `caption: Fill the textbox named Email with demo+{{unique}}@example.com` |
| `caption: Place the order` | `caption: Step 9` |

## Make the workflow repeatable

Each replay does the workflow again, so the workflow must work each time.

- **New data:** use `{{unique}}` in values that must be new, like an email or a user name: `demo+{{unique}}@example.com`. Each run and each replay gets a new value.
- **Logins:** use `{{secret:NAME}}` for passwords, with the value in `.walkthrough/.env`. To start logged in, add `session: <name>` to the plan. The replay loads that saved login into its new login.
- **Clean start:** the replay starts in a new login with no cookies and no storage. Do not rely on data from an earlier run, like a full cart.
- **Data that changes:** when the page shows data that changes, like stock or prices, add a `mock` step with fixed data. See "Mocked requests" in `references/plan-format.md`.
- **Dialogs:** the replay answers each dialog like the run did. When the run has no answer for a dialog, the replay accepts it.

## Pace, size, and formats

- `pace`: `slow` types 90 ms for each character and holds 1.8 seconds at the end of each step. `normal` types 50 ms and holds 1.2 seconds. `fast` types 20 ms and holds 0.7 seconds.
- `width`: the page and the video width, 1280 by default, at 16:10. A plan with a `device` uses that device's screen.
- `format`: `mp4` for most players and GitHub, `gif` for Markdown and issues, `webm` for browsers. A GIF can be up to `video.maxGifSeconds` long (60 seconds).
- `path`: also save the video to an exact file, like `docs/images/checkout.gif`.

## Privacy

- The replay hides a field before it types a secret into it. Password fields show dots.
- The replay hides the Walkthrough panel.
- The video shows everything else on the page, like names and email addresses. Use test data.
