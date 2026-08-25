# Amex Shopwise — Amazon Pay gift card autobuy

Buys a ₹1,000 Amazon Pay gift card on the Amex Shopwise portal, once a month, six
times. The one thing you do is send the OTP.

```
you                     script
 │                        │
 │                        ├─ log in (reuses the saved session when it can)
 │                        ├─ search "Amazon Pay", pick ₹1,000, add to cart
 │                        ├─ read the real total off the page and check it
 │                        ├─ fill your card details
 │   ← "OTP needed"       │
 ├─ tap the code ────────►│
 │                        ├─ submit, wait for confirmation
 │                        └─ record the run (3 of 6 done)
```

## Read this before you run it

- **It stops before paying by default.** `run` is a dry run: it fills the cart and
  verifies the amount, then stops. Payment only happens with `--live`.
- **It refuses to pay an amount it did not verify.** The flow reads the order total
  off the checkout page. Anything other than exactly `AMOUNT` — a leftover cart
  item, a changed price, a total it cannot parse — aborts before your card is
  touched. There is a test for this.
- **The selectors are guesses.** This was written without access to the live portal,
  so the first run will need corrections. `calibrate` makes that quick. See
  [Fixing selectors](#fixing-selectors).
- **Your card sits on disk, encrypted.** Unattended monthly runs mean the CVV has to
  be stored somewhere; there is no way around that. It is AES-256-GCM encrypted
  under a scrypt-derived key rather than sitting in a plaintext `.env`. If the
  passphrase is also on the same device (`vault.key`, for cron), someone with your
  unlocked phone can get both. Judge that against what a ₹1,000 monthly card is
  worth to you.
- **The portal may not want to be automated.** Check Shopwise's terms. Anti-bot
  measures may block a headless browser, and an account can be locked for it.

## Running it on your phone

Being blunt about this, because it decides your setup:

| Phone | Works? | How |
|---|---|---|
| **Android** | Yes | Termux — the script runs on the phone itself |
| **iPhone** | No | iOS cannot run a background browser automation. Run it on a laptop, a Raspberry Pi, or a cheap VPS, and use the phone only to send the OTP |

Either way the OTP step is identical: the script opens a little web page, you open
it on your phone, you type the code.

### Android (Termux)

Install [Termux from F-Droid](https://f-droid.org/packages/com.termux/) — the Play
Store build is too old.

```bash
pkg update && pkg install nodejs-lts git chromium termux-api
git clone https://github.com/Karanmittal01/AmEx-Shopwise.git
cd AmEx-Shopwise
npm install

# Playwright has no ARM/Android browser download, so point it at Termux's chromium
echo "CHROMIUM_PATH=$(command -v chromium)" >> .env

# Stop Android killing the process mid-purchase
termux-wake-lock
```

Install the **Termux:API** app too, and you get a real Android notification when the
OTP is needed.

### Anywhere else (laptop, Pi, VPS)

```bash
git clone https://github.com/Karanmittal01/AmEx-Shopwise.git
cd AmEx-Shopwise
npm install
npx playwright install chromium
```

Make sure the machine and your phone are on the same Wi-Fi, so the OTP page is
reachable from the phone.

## Setup

```bash
cp .env.example .env      # adjust SHOPWISE_URL if the real URL differs
node src/index.js setup   # stores login + card, encrypted
```

`setup` asks for your Shopwise login, card number, expiry, CVV and a passphrase.
Nothing is echoed to the screen. It offers to write the passphrase to `vault.key`
(mode 0600) so cron can run unattended — say no if you would rather type it each
month, and set `SHOPWISE_VAULT_PASS` yourself.

## First run — watch it

Do this once, with the browser visible, so you can see where the selectors are wrong:

```bash
HEADLESS=false node src/index.js run --headful
```

No payment happens. It should reach the cart, print

```
order total on page: "Order total ₹1,000.00" → parsed 1000
amount verified: ₹1000
DRY RUN — cart is correct and the flow stopped before payment.
```

and stop. When that works, do one live purchase by hand:

```bash
node src/index.js run --live
```

When it needs the OTP it prints a URL. Open it on your phone, type the code, done.
Or `echo 123456 > otp.txt`, or `curl "http://localhost:8787/otp?code=123456"`, or
just type it into the terminal — whichever arrives first wins.

## The monthly schedule

Once a live run has worked, hand it to cron. `--if-due` does the thinking: one
purchase per calendar month, six in total, then it stops on its own. Firing more
often than monthly is harmless and means a missed wake-up gets picked up later.

**Linux / macOS / Pi** — `crontab -e`:

```cron
0 11 1,2,3 * * /path/to/AmEx-Shopwise/bin/shopwise-monthly.sh
```

(The 1st, 2nd and 3rd — if the phone is off on the 1st, the 2nd catches it, and the
run on the 2nd is a no-op if the 1st already succeeded.)

**Android / Termux**:

```bash
pkg install cronie termux-services
sv-enable crond
crontab -e     # same line as above
```

Install **Termux:Boot** as well so cron survives a reboot.

Either way you get a notification when the OTP is needed. Send it and the purchase
completes. Check progress any time:

```bash
node src/index.js status
```

```
Progress: 2 of 6 monthly purchases
This month (2026-10): already purchased in 2026-10

  2026-09  2026-09-01T11:00:12.001Z  success   ₹1000 — Order ID SW10482911
  2026-10  2026-10-01T11:00:09.412Z  success   ₹1000 — Order ID SW10559120
```

## Fixing selectors

When a step cannot find its element the error tells you which step failed, what it
tried, and where the screenshots are:

```
Could not find "addToCart" on https://…/product.
Tried: role=button|Add to cart | text=Add to cart | css=button[data-action='add-to-cart']
Fix it by adding a working selector under "addToCart" in selectors.local.json
```

Dump what is actually on the page:

```bash
node src/index.js calibrate https://www.amexshopwise.com/some/page
```

That writes `runs/calibrate-*.json` listing every clickable element with its id,
name, placeholder, test id and text. Pick one and create `selectors.local.json` in
the project root:

```json
{
  "addToCart": ["css=#buy-now", "role=button|Buy now"],
  "orderTotal": ["css=.checkout__grand-total"]
}
```

Your file wins over the shipped defaults for those keys, and survives updates.
Locator syntax: `css=`, `text=`, `role=button|Name`, `placeholder=`, `label=`,
`testid=`. Candidates are tried in order, across every frame on the page — that is
how the card fields inside the payment-gateway iframe get found.

## Configuration

Everything lives in `.env` (see `.env.example`). The ones that matter:

| Variable | Default | |
|---|---|---|
| `SHOPWISE_URL` | `https://www.amexshopwise.com/` | Portal entry point |
| `AMOUNT` | `1000` | Denomination to buy |
| `MAX_AMOUNT` | `1000` | Hard ceiling; refuses to pay above this |
| `TOTAL_RUNS` | `6` | Purchases before the schedule retires |
| `HEADLESS` | `true` | `false` to watch the browser |
| `CHROMIUM_PATH` | — | Required on Termux/ARM |
| `OTP_PORT` | `8787` | Where the OTP page listens |
| `OTP_TIMEOUT_MS` | `360000` | 6 minutes to send the code |

## What it does not do

- **It does not read your SMS.** Deliberate. You see each purchase and approve it by
  sending the code; not sending one cancels the purchase. That is the whole safety
  model, and automating it away would remove the only human check on a script that
  spends money.
- **It does not retry a failed payment on its own.** A failure is recorded and the
  month stays open, so the next cron tick tries again — but it will never fire twice
  in a month after a success.

## Tests

```bash
npm test
```

Nine tests. The unit tests cover amount parsing, vault encryption (including
tamper detection), the monthly scheduler and log redaction. The end-to-end tests
run the real flow against a mock portal in `test/mock-portal.js` — login with OTP,
search, denomination, cart, card fields inside an iframe, payment OTP,
confirmation — and assert that a dry run never reaches the payment endpoint and
that a tampered ₹1,500 total aborts before the card is sent.

## Files

```
src/index.js       CLI: setup, calibrate, run, status, reset
src/flow.js        the purchase flow and the amount guardrail
src/locate.js      multi-candidate, multi-frame element finding
src/selectors.json default selectors — override in selectors.local.json
src/otp.js         the OTP relay (web page, file drop, terminal)
src/vault.js       AES-256-GCM encrypted card storage
src/state.js       one per month, six in total
src/log.js         logging with secret redaction
```

`vault.enc`, `vault.key`, `.env`, `state.json` and `runs/` are gitignored. Keep it
that way.
