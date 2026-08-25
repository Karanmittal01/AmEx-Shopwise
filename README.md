# Amex Shopwise — Amazon Pay gift card

Buys the ₹1,000 Amazon Pay gift card on
[shopwise.giftstacc.com](https://shopwise.giftstacc.com/). You tap Buy on your
phone and send the two OTPs. That's the whole thing.

## Use it — Android phone only, no laptop

See [`docs/android.md`](docs/android.md) for the full copy-paste, but it comes
down to installing **Termux** (a free terminal app) and then:

```bash
npm run setup     # once: your mobile number and card, encrypted on this phone
npm run buy       # every time
```

`npm run buy` prints a link. Open it in your phone's browser (it's the same
phone, so `localhost` just works), tap **Buy**, and type each OTP as it arrives.
Add the link to your home screen and it behaves like an app.

That's it. One app, one command. No cloud, no server, no laptop, nothing to pay
for.

---

**On a laptop instead?** Same two commands after
`npm install && npx playwright install chromium`; `npm run buy` prints a
`192.168.x.x` link to open on your phone over the same Wi-Fi.

`npm run buy` prints a URL:

```
  Open this on your phone:

    http://192.168.1.42:8787/

  Card **** **** **** 1008 · ₹1000 card, about ₹1017.7 charged

  Waiting for you to tap Buy…
```

Open it on your phone (same Wi-Fi), tap **Buy**, and type each OTP as it arrives.
The page shows what's happening — signing in, cart checked, entering card — and
the final order number. Bookmark the URL to your home screen and it behaves like
an app.

That's it. One command, one process, no accounts, no server, nothing deployed.

## Why it can't be simpler than this

A browser has to drive the portal. It's a React app whose API takes
AES-encrypted headers derived from a per-session key, so there is no clean set of
HTTP calls to script from a Shortcut — and even if there were, they'd break on
the portal's next deploy. That means Node plus a real Chromium, which in turn
means a laptop or a small always-on box. **iOS can't run it locally**, so on an
iPhone the phone is the remote control and something else does the driving.

Two OTPs also have to come from you, every time: the portal signs you in with a
code rather than a password, and then the bank sends a second one for the
payment. So it can never be fully unattended — the best possible version is
exactly this: tap once, type twice.

## What it protects you from

- **It won't pay an amount it didn't check.** It reads the real total off the
  checkout page and requires it to land between the face value and a computed
  ceiling. A second item in the cart, a changed fee, or a total it can't parse
  all abort *before* the card is entered.
- **You're charged ₹1,017.70, not ₹1,000.** The portal adds 1.5% convenience fee
  plus 18% GST on that fee. The page shows the real figure before you commit.
- **Test run first.** The second button on the page fills the cart, checks the
  amount and stops without paying. Use it after any change.
- **Nothing sensitive is written down.** The card is AES-256-GCM encrypted at
  rest, never logged, and blurred out of the screenshots taken when a step fails.

## When a step breaks — just tap it

The selectors were written from the portal's public JavaScript, not a live
session, so a step will sometimes fail to find its button the first time. You
don't fix that in a file. The phone page shows you the buttons it *did* find and
asks:

> **Which one is it?**
> Couldn't find the **addToCart** button. Tap it in the list below.
> `button: Add to cart` · `button: ₹1,000` · `link: Cart` · …

Tap the right one and it carries on — and remembers, so it never asks for that
step again. That's the whole repair: no terminal, no JSON, no re-run.

(Under the hood it saves your choice to `selectors.local.json`. You never have to
open that file, but if you ever want to, it's plain text and yours to edit.)

Screenshots and a scrubbed log for every run land in `runs/`, if a step ever
fails in a way tapping can't fix.

## Progress

```bash
npm run status
```

```
Progress: 2 of 6 monthly purchases
This month (2026-10): already purchased in 2026-10
```

One purchase per calendar month, six in total. A failed attempt doesn't count, so
you can just run it again.

## Optional: make it always-on

Only worth it if you want to buy without opening a laptop. The same code runs as
a long-lived worker driven from a web page instead of a terminal — see
[`docs/always-on.md`](docs/always-on.md). Skip this unless you actually want it;
the command above is the intended way to use this.

## Tests

```bash
npm test
```

Eighteen tests against a mock portal — mobile+OTP sign-in, the fee breakdown,
card fields inside a gateway iframe. No network, no real money. They cover the
full purchase driven from the control page, a test run never reaching the payment
endpoint, an over-ceiling total aborting before the card is submitted, and the
card, CVV and OTP never appearing in logs.

## Files

```
src/index.js       commands: setup, buy, status, calibrate
src/control.js     the phone page
src/flow.js        the purchase, and the amount check
src/locate.js      finding elements across frames, with fallbacks
src/selectors.json default selectors — override in selectors.local.json
src/vault.js       encrypted card storage
```

`vault.enc`, `vault.key`, `.env`, `state.json` and `runs/` are gitignored. Keep
it that way.
