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
|---|---|---|
| Wrong total | Cart | With two different items, the total counts the first item twice. Mug ($10) + T-shirt ($20) shows $40.00, not $30.00. |
| Console error | Cart, "Apply coupon" | Nothing happens. The DevTools console shows a TypeError. |
| Server error | Shop, "Check stock" | The request returns HTTP 500 and the page says it could not check stock. |

## Planted accessibility issues

- The Baseball Cap image has no alt text.
- The coupon field has no label.

## Walkthrough files

The `.walkthrough/` folder holds the settings and test plans for this project. Copy `.walkthrough/.env.example` to `.walkthrough/.env` to set the demo password as a secret.
