# Optional: buying without opening a laptop

**You probably don't need this.** `npm run buy` covers it: run the command, tap
Buy on your phone, send two OTPs. This page is only for wanting to buy with no
laptop involved at all — which means something has to be switched on and waiting.

There are two ways, and they differ only in where the button lives.

## 1. The same command, on a machine that stays on

A Raspberry Pi, an old laptop, a cheap VPS. Run `npm run buy` there and leave it;
the control page waits until you tap Buy. To reach it from outside your home
Wi-Fi, put [Tailscale](https://tailscale.com/) on the box and your phone, and use
the Tailscale address instead of the LAN one.

That's it. Nothing else to install, no accounts, no tokens.

## 2. Driven from Splitwise Killer

If you'd rather the button lived in an app you already open, there is a **Tools →
Amazon Pay gift card** page in
[Splitwise Killer](https://github.com/Karanmittal01/Splitwise-Killer). It's more
moving parts — a database table, a shared token, a worker process — in exchange
for the button being somewhere you already are, reachable from anywhere without
Tailscale.

**Web app** — set two environment variables and redeploy:

| Name | Value |
|---|---|
| `OWNER_EMAIL` | your account's email; only this account sees Tools |
| `SHOPWISE_WORKER_TOKEN` | `openssl rand -hex 32` |

**Worker** — in this repo's `.env`:

```bash
APP_URL=https://split.karanmittal.com
WORKER_TOKEN=<the same token>
```

```bash
npm run worker
```

It polls the app for work, so it needs no open ports and no public address. The
card stays encrypted here; the app is told amounts, progress and order numbers,
never a card number.

### On a container host

Fly, Railway and Render have no persistent disk for `vault.enc`, and baking it
into an image would put the card in a layer. Hand it over as a secret instead —
it's still ciphertext, and the passphrase travels separately:

```bash
fly launch --no-deploy
fly secrets set \
  APP_URL="https://split.karanmittal.com" \
  WORKER_TOKEN="<same token>" \
  SHOPWISE_VAULT_PASS="<your vault passphrase>" \
  SHOPWISE_VAULT_B64="$(base64 -w0 vault.enc)"
fly deploy
```

Copy `selectors.local.json` into the repo before deploying, so your fixes ship
with it.

**Vercel cannot host the worker.** Serverless functions are stateless and capped
at 60s (Hobby) / 300s (Pro); a purchase holds a browser open for minutes across
two OTP waits. The web app on Vercel is fine — only the worker needs elsewhere.

## Reminders

Nothing here reminds you to buy. Because you have to be present for the OTPs, the
most that can be automated is the nudge, not the purchase. A monthly calendar
event on the 1st is the least machinery that solves it.
