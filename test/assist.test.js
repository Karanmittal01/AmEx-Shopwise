import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockPortal } from './mock-portal.js';

/**
 * Tap-to-fix, driven the way it is meant to be used on a phone: a step's shipped
 * selectors all miss, the page offers the real buttons, a tap picks the right
 * one, it is saved to selectors.local.json, and the purchase carries on to
 * completion — no terminal, no JSON editing.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopwise-assist-'));

process.env.AMOUNT = '1000';
process.env.HEADLESS = 'true';
process.env.SLOW_MO_MS = '0';
process.env.STEP_TIMEOUT_MS = '6000'; // short: the assist path is reached after a miss
process.env.OTP_PORT = '8795';
process.env.PROFILE_DIR = path.join(tmp, 'profile');
process.env.RUNS_DIR = path.join(tmp, 'runs');
process.env.SELECTORS_LOCAL_FILE = path.join(tmp, 'selectors.local.json');
process.env.CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const portal = await startMockPortal();
process.env.SHOPWISE_URL = portal.url;

const { config, loadSelectors } = await import('../src/config.js');
const { startControlServer } = await import('../src/control.js');
const { runPurchase } = await import('../src/flow.js');
const { setOtpProvider } = await import('../src/otp.js');
const { setAssistProvider } = await import('../src/locate.js');
const { makeAssistProvider } = await import('../src/assist.js');

const vault = {
  portalMobile: portal.mobile,
  cardNumber: portal.card.number,
  cardExpMonth: '12',
  cardExpYear: '30',
  cardCvv: portal.card.cvv,
  cardName: 'A CARDHOLDER',
};

test.after(async () => {
  await portal.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('a broken selector is fixed by tapping the right element', { timeout: 240_000 }, async () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
  fs.rmSync(process.env.SELECTORS_LOCAL_FILE, { force: true });

  const control = await startControlServer({ port: 0, amount: 1000 });
  setOtpProvider(control.requestOtp);
  setAssistProvider(makeAssistProvider(control));

  // Break addToCart on purpose: none of these match the mock's "Add to cart".
  const selectors = loadSelectors();
  selectors.addToCart = ['css=#definitely-not-here', 'text=Nope Nope Nope'];

  const base = `http://127.0.0.1:${control.port}`;
  const getState = async () => (await fetch(`${base}/state`, { cache: 'no-store' })).json();
  const post = (p, b) =>
    fetch(`${base}${p}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(b),
    });

  // Auto-responder: answer OTPs, and when asked to pick, tap the real Add to cart.
  const responder = setInterval(async () => {
    const s = await getState().catch(() => null);
    if (!s) return;
    if (s.otp.pending) return void post('/otp', { code: portal.otp }).catch(() => {});
    if (s.pick.pending) {
      const i = s.pick.choices.findIndex((label) => /add to cart/i.test(label));
      if (i >= 0) await post('/pick', { index: i }).catch(() => {});
    }
  }, 200);

  try {
    const result = await runPurchase({
      vault,
      selectors,
      live: true,
      runDir: path.join(tmp, 'run'),
      onProgress: async (u) => control.setPhase(u),
    });

    assert.equal(result.status, 'success', 'the purchase should complete after the fix');
    assert.equal(result.total, 1017.7);

    // The fix was persisted, picked selector first.
    const saved = JSON.parse(fs.readFileSync(process.env.SELECTORS_LOCAL_FILE, 'utf8'));
    assert.ok(Array.isArray(saved.addToCart), 'addToCart should be saved');
    assert.ok(
      /add to cart/i.test(saved.addToCart[0]) || saved.addToCart[0].startsWith('css='),
      `expected a real selector, got ${saved.addToCart[0]}`,
    );

    // And the purchase actually went through at the portal.
    assert.equal(portal.state.cart, 1000);
    assert.equal(portal.state.payment.number, portal.card.number);
  } finally {
    clearInterval(responder);
    setOtpProvider(null);
    setAssistProvider(null);
    await control.close();
  }
});

test('card and CVV fields are never offered as pick targets', { timeout: 120_000 }, async () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
  const { enumerateChoices } = await import('../src/assist.js');
  const { launchBrowser } = await import('../src/flow.js');

  const context = await launchBrowser();
  const page = context.pages()[0] || (await context.newPage());
  try {
    // The gateway page is where the sensitive fields live.
    await page.goto(`${portal.url}gateway`, { waitUntil: 'domcontentloaded' });
    const choices = await enumerateChoices(page);
    const labels = choices.map((c) => c.label.toLowerCase()).join(' | ');
    const selectors = choices.map((c) => c.selector.toLowerCase()).join(' | ');

    assert.ok(!/cvv|cvc/.test(labels + selectors), `a CVV field was offered: ${labels}`);
    assert.ok(!/cardnumber|card number/.test(selectors), `a card field was offered: ${selectors}`);
  } finally {
    await context.close();
  }
});
