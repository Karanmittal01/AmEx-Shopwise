# Amex Shopwise — Amazon Pay gift card autobuy

Buys the ₹1,000 Amazon Pay gift card on
[shopwise.giftstacc.com](https://shopwise.giftstacc.com/), once a month, six
times. You tap a button in Splitwise Killer and send two OTPs. Nothing else.

```
  any browser, any device              this worker
  ─────────────────────────            ───────────────────────────
  split.karanmittal.com                Node + Chromium
  /tools/shopwise                      + the encrypted card vault
        │                                    │
        │  "Buy"  ──► job queued  ◄────────── polls for work
        │             (Postgres)              │
        │                                     ├─ signs in
        │  OTP box ◄── "needs OTP" ◄──────────┤
        │  you type it ──► relayed ──────────►┤
        │                                     ├─ ₹1,000 card → cart
        │                                     ├─ checks the total
        │                                     ├─ enters the card
        │  OTP box ◄── "needs OTP" ◄──────────┤
        │  you type it ──► relayed ──────────►┤
        └────────── "bought, ₹1,017.70" ◄─────┘
```

The worker only ever calls **out** to the app, so it needs no public IP, no open
ports and no certificate of its own. The card never leaves this machine: the web
app is told amounts, phases and order IDs, and nothing else.

## Read this before you run it

- **It stops before paying by default.** A "Test run" fills the cart, verifies the
  amount and stops. Only "Buy" spends money.
- **It refuses to pay an amount it did not verify.** The worker reads the real
  total off the checkout page and requires it to fall between the face value
  floor and a computed ceiling. A second item in the cart, a changed fee or an
  unparseable total all abort before the card is entered. There are tests for
  this.
- **You are charged more than ₹1,000.** The portal adds a convenience fee and GST
  on that fee, so the real charge is about **₹1,017.70**:

  ```
  fee   = faceValue × 1.5% × 1.18   = ₹17.70
  total = ₹1,000 + ₹17.70           = ₹1,017.70
  ```

  Those percentages come from the portal's own API and can change, which is why
  the flow reads the total rather than assuming it.
- **Two OTPs per run.** The portal signs you in by mobile number and an OTP every
  time — there is no password to skip it with — and then the bank sends a second
  OTP for the payment.
- **The selectors are informed guesses.** They were written from the portal's
  public JavaScript bundle, not from a signed-in session, so expect the first run
  to need corrections. See [Fixing selectors](#fixing-selectors).
- **Your card sits on disk, encrypted.** Unattended runs mean the CVV has to be
  stored somewhere. It is AES-256-GCM encrypted under a scrypt-derived key rather
  than sitting in a plaintext `.env`. If the passphrase lives on the same machine
  (`vault.key`, for unattended runs) then whoever has that machine has both.
- **The portal may not want to be automated.** Check its terms. Anti-bot measures
  can block a headless browser, and accounts can be locked for it.

## Where the worker runs

It needs Node and a real Chromium, and it has to stay alive for the few minutes a
purchase takes. That rules out some hosts:

| Host | Works? | |
|---|---|---|
| **Vercel** | No | Serverless functions are stateless and capped at 60s (Hobby) / 300s (Pro). A run takes minutes and holds a browser open. |
| **Fly.io / Railway / Render** | Yes | A persistent container. Use the `Dockerfile`. Cheapest cloud option. |
| **A VPS** | Yes | Hetzner, DigitalOcean, Oracle free tier. Docker or systemd. |
| **Raspberry Pi / spare machine** | Yes | Free, and the card vault stays on hardware you own. Polls outward, so no router configuration. |
| **Your laptop, on demand** | Yes | Start `npm run worker` when a purchase is due, tap Buy, close it afterwards. No always-on anything. |

Splitwise Killer being on Vercel is fine — only the worker needs a home.

## Setup

```bash
git clone https://github.com/Karanmittal01/AmEx-Shopwise.git
cd AmEx-Shopwise
npm install
npx playwright install chromium     # skip on Termux/ARM; set CHROMIUM_PATH instead

cp .env.example .env
node src/index.js setup
```

`setup` asks for your Shopwise mobile number, the card, and a passphrase to
encrypt them. Nothing is echoed to the screen and nothing is ever logged. It
offers to write the passphrase to `vault.key` (mode 0600) so the worker can start
unattended.

Then generate a shared secret and put the **same value** in both places:

```bash
openssl rand -hex 32
```

| Where | Variable |
|---|---|
| this repo's `.env` | `WORKER_TOKEN` |
| the web app's environment | `SHOPWISE_WORKER_TOKEN` |

Also set `APP_URL=https://split.karanmittal.com` here, and `OWNER_EMAIL` to your
own address in the web app — that is what makes the Tools section appear, and it
is the only account allowed to use it.

## First run — watch it

Do this once with the browser visible, so you can see which selectors are wrong:

```bash
HEADLESS=false node src/index.js run --headful
```

No payment happens. It should reach the cart and print:

```
order total on page: "Total Amount ₹1,017.70" → parsed 1017.7
expecting ~₹1017.7 (₹1000 + ₹17.7 fee at 1.5% + 18% GST), ceiling ₹1019.7
amount verified: ₹1017.7 (fee ₹17.7)
DRY RUN — cart is correct and the flow stopped before payment.
```

When that works, start the worker and drive it from your phone instead:

```bash
npm run worker
```

Open **Tools → Amazon Pay gift card** in Splitwise Killer, hit *Test run*, and
watch it go through. Then *Buy* for the real thing.

## Running the worker for real

**Docker** (any host):

```bash
docker build -t shopwise-worker .
docker run -d --restart unless-stopped --name shopwise \
  --env-file .env \
  -v "$PWD/vault.enc:/app/vault.enc:ro" \
  -v "$PWD/vault.key:/app/vault.key:ro" \
  -v "$PWD/runs:/app/runs" \
  shopwise-worker
```

The vault is mounted, never copied into the image, so it cannot end up in a layer
you later push to a registry.

**Fly.io** (no hardware of your own):

```bash
fly launch --no-deploy            # detects the Dockerfile
fly secrets set \
  APP_URL="https://split.karanmittal.com" \
  WORKER_TOKEN="<the same token as the web app>" \
  SHOPWISE_VAULT_PASS="<your vault passphrase>" \
  SHOPWISE_VAULT_B64="$(base64 -w0 vault.enc)"
fly deploy
```

The vault travels as ciphertext in a secret, so there is no volume to manage and
nothing sensitive in the image. Opening it still needs the passphrase, so one
leaked secret is not enough on its own.

**systemd** (VPS or Pi):

```ini
# /etc/systemd/system/shopwise.service
[Service]
WorkingDirectory=/home/karan/AmEx-Shopwise
ExecStart=/usr/bin/node src/index.js worker
Restart=always
RestartSec=30
User=karan

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now shopwise
```

The worker idles at essentially zero CPU between polls; Chromium only launches
when a job actually arrives.

## Fixing selectors

When a step cannot find its element, the error says which step, what it tried,
and where the screenshots are:

```
Could not find "addToCart" on https://shopwise.giftstacc.com/product/…
Tried: role=button|Add to cart | text=Add to cart | css=button[data-action='add-to-cart']
Fix it by adding a working selector under "addToCart" in selectors.local.json
```

Dump what is really on a page:

```bash
node src/index.js calibrate https://shopwise.giftstacc.com/some/page
```

That writes `runs/calibrate-*.json` listing every clickable element with its id,
name, placeholder, test id and text. Pick one and create `selectors.local.json`:

```json
{
  "addToCart": ["css=#buy-now", "role=button|Buy now"],
  "orderTotal": ["css=.checkout__grand-total"]
}
```

Your file replaces the shipped candidates for those keys and survives updates.
Locator syntax: `css=`, `text=`, `role=button|Name`, `placeholder=`, `label=`,
`testid=`. Candidates are tried in order across every frame on the page — that is
how card fields inside the payment gateway's iframe get found.

Since the portal is a React app with minified class names, prefer selectors based
on visible text, placeholders and labels: those survive a rebuild, `css=.lsss3`
does not.

## Commands

```
node src/index.js setup             Store mobile + card, encrypted
node src/index.js worker            Poll the Tools page and run purchases
node src/index.js run [--live]      Run once from this terminal
node src/index.js calibrate [url]   Dump a page's real selectors
node src/index.js status            Local run history
node src/index.js reset             Clear the local history (leaves the vault)
```

`run` is the standalone path and does not need the web app at all: it relays the
OTP through a small local page, a file drop (`echo 123456 > otp.txt`) or the
terminal. Useful for debugging without a round trip through Postgres.

## Configuration

| Variable | Default | |
|---|---|---|
| `SHOPWISE_URL` | `https://shopwise.giftstacc.com/` | Portal entry point |
| `AMOUNT` | `1000` | Gift card face value |
| `FEE_PERCENT` / `GST_PERCENT` | `1.5` / `18` | Used for the ceiling, not to compute what you pay |
| `MAX_AMOUNT` | derived | Absolute ceiling; overrides the computed one |
| `TOTAL_RUNS` | `6` | Purchases before the schedule retires |
| `APP_URL` | — | The web app, for worker mode |
| `WORKER_TOKEN` | — | Must match `SHOPWISE_WORKER_TOKEN` in the app |
| `HEADLESS` | `true` | `false` to watch the browser |
| `CHROMIUM_PATH` | — | Needed on ARM/Termux, where Playwright has no download |
| `OTP_TIMEOUT_MS` | `360000` | How long you have to send each code |

## What it does not do

- **It does not read your SMS.** Deliberate. You see each purchase and approve it
  by sending the code; not sending one cancels it. That is the only human check
  on a script that spends money, and automating it away would remove the point.
- **It does not retry a failed payment by itself.** A failure is recorded and the
  month stays open, so you can simply tap Buy again. After a success, that month
  is closed and the sixth success retires the schedule.

## Tests

```bash
npm test
```

Fourteen tests, no network and no real money. `test/mock-portal.js` is a
stand-in for the portal — mobile+OTP sign-in, denomination tiles, a cart showing
the fee breakdown, card fields inside an iframe, a bank OTP step — and
`test/mock-app.js` mirrors the Tools API. Between them they cover:

- the full purchase, end to end, including both OTPs relayed through the web app
- a dry run never reaching the payment endpoint
- a total above the ceiling aborting **before** the card is submitted
- the real ₹17.70 fee being accepted rather than treated as tampering
- card number, CVV and OTP never appearing in logs or error reports
- vault encryption, tamper detection, and the one-per-month schedule

## Files

```
src/index.js       CLI: setup, worker, run, calibrate, status, reset
src/worker.js      the polling loop that talks to Splitwise Killer
src/remote.js      Tools API client (claim, progress, OTP, finish)
src/flow.js        the purchase flow and the amount guardrail
src/locate.js      multi-candidate, multi-frame element finding
src/selectors.json default selectors — override in selectors.local.json
src/otp.js         OTP relay for standalone runs
src/vault.js       AES-256-GCM encrypted card storage
src/log.js         logging with secret redaction
```

`vault.enc`, `vault.key`, `.env`, `state.json` and `runs/` are gitignored. Keep
it that way.
