# Running it on an Android phone — no laptop

Everything runs on the phone itself. You install one app (Termux), paste a few
lines once, and after that it's `npm run buy` whenever you want a gift card.

## One-time setup

### 1. Install Termux

Install **Termux** from **F-Droid**, not the Play Store — the Play Store version
is old and won't work:

1. Open <https://f-droid.org/> in your phone browser and install F-Droid.
2. In F-Droid, search **Termux** and install it.
3. Also install **Termux:API** the same way (it lets the phone buzz you when an
   OTP is needed).

### 2. Paste this into Termux

Open Termux and paste these lines (long-press to paste). It installs the tools,
downloads the project, and points it at the phone's own Chromium:

```bash
pkg update -y && pkg install -y nodejs git chromium termux-api
git clone -b claude/amex-shopwise-amazon-pay-script-btoe42 https://github.com/Karanmittal01/AmEx-Shopwise.git
cd AmEx-Shopwise
npm install
cp .env.example .env
echo "CHROMIUM_PATH=$(command -v chromium)" >> .env
termux-wake-lock
```

`termux-wake-lock` stops Android from freezing the app mid-purchase.

### 3. Store your details

```bash
npm run setup
```

It asks for your Shopwise **mobile number**, your **card**, and a **passphrase**
you make up (you'll type it before each purchase — or say yes when it offers to
remember it on this phone). Nothing you type is shown on screen.

## Every purchase

In Termux:

```bash
cd AmEx-Shopwise
npm run buy
```

It prints a link like `http://localhost:8787/`. **Tap it** (Termux makes links
tappable) — it opens in your phone browser. Then:

1. Tap **Buy ₹1,000 gift card** (or **Test run** first, which stops before
   paying).
2. When it asks, type the **login OTP** your phone receives.
3. If it ever says **"Which one is it?"**, tap the right button from the list —
   see [the main README](../README.md#when-a-step-breaks--just-tap-it). It only
   asks once per button, ever.
4. Type the **payment OTP** when the bank sends it.
5. It shows the order number. Done.

Leave Termux running while the page works (don't swipe it away). Once it says
Bought, you can close everything.

### Make the link a home-screen icon

In your browser, open `http://localhost:8787/` while a purchase is running, then
**⋮ → Add to Home screen**. Next month, start `npm run buy` in Termux, then tap
that icon.

## If the phone sleeps or Wi-Fi drops mid-purchase

Just start over — `npm run buy` again. Nothing is charged unless you reach the
payment OTP and send it, and a half-finished attempt leaves the month open, so
running it again is always safe.

## Reminders

Nothing reminds you to buy each month — because you have to be there for the
OTPs, that part can't be automated. Set a monthly phone calendar event on the 1st
and let it nudge you; the purchase itself is then two taps and two codes.
