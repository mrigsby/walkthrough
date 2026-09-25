# Demo shop

A small shop for testing Walkthrough. It has bugs on purpose.

## Start it

From the repo root:

```sh
npm run demo
```

Then open http://localhost:4321. Log in with username `demo` and password `demo123`.

## What is in it

- Pages: shop, cart, checkout, login, account, and order confirmation. The app changes pages without a full reload.
- A payment form inside an iframe on the checkout page.
- A confirm dialog when you place an order.
- A file upload on the account page.
- A Help link that opens in a new tab.
- A link to example.com, which is outside the allowed sites.

## Planted bugs

| Bug | Where | What you see |
| --- | --- | --- |
| Wrong total | Cart | With two different items, the total counts the first item twice. Mug ($10) + T-shirt ($20) shows $40.00, not $30.00. |
| Console error | Cart, "Apply coupon" | Nothing happens. The DevTools console shows a TypeError. |
| Server error | Shop, "Check stock" | The request returns HTTP 500 and the page says it could not check stock. |

## Planted accessibility issues

| Issue | Page | Found by |
| --- | --- | --- |
| The Baseball Cap image has no alt text. | Shop | axe (`image-alt`) |
| The heart buttons have an icon but no name. | Shop | axe (`button-name`) |
| The "Free shipping over $50" note has low contrast. | Shop | axe (`color-contrast`) |
| "Quick view" is a `div`. You can click it, but you cannot reach it with Tab. | Shop | Keyboard check |
| Tab and Shift+Tab cannot leave the "Get deals" email field. | Shop | Keyboard check |
| The Log in button shows no focus ring. | Log in | Keyboard check |
| The "Forgot your password?" hint has low contrast in dark mode only. | Log in | Dark mode check |
| The coupon field has no label. The text "Have a coupon?" is next to it, but it is not tied to the field. | Cart | axe (`label`) |
| The "Name on card" field in the payment form has no label. | Checkout (payment frame) | axe (`label`), frame check |
| The shipping rates banner is 700px wide, so the page scrolls sideways on a phone. | Help | Reflow check |
| The "Was this page helpful?" checkbox has no label. It is inside a shadow root. | Help | axe (`label`) |

The keyboard, dark mode, reflow, and frame checks are part of the accessibility report. To see the cart and checkout issues, add an item to the cart first.

## Walkthrough files

The `.walkthrough/` folder holds the settings and test plans for this project. Copy `.walkthrough/.env.example` to `.walkthrough/.env` to set the demo password as a secret.

## Screenshots for docs

The `help-shots` plan saves two screenshots to exact files in `docs/images/help/`: the cart page, and the cart total only. Ask the agent to "run the help-shots plan", then export the run as a script. The script saves the screenshots again without an agent:

```sh
node .walkthrough/exports/help-shots.mjs
SHOT=total node .walkthrough/exports/help-shots.mjs
```

The second command saves only `total.png`. See [Screenshots for docs](../../docs/plan-format.md#screenshots-for-docs).
