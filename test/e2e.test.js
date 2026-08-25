import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockPortal } from './mock-portal.js';

/**
 * Drives the real flow against the mock portal: login + login OTP, search,
 * denomination, cart, amount verification, card fields inside an iframe, payment
 * OTP, confirmation. This is what proves the selector engine and the guardrails
 * actually work — the unit tests only cover the helpers.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopwise-e2e-'));

// Config is read at import time, so the environment has to be set up first.
process.env.AMOUNT = '1000';
process.env.MAX_AMOUNT = '1000';
process.env.SEARCH_TERM = 'Amazon Pay';
process.env.HEADLESS = 'true';
process.env.SLOW_MO_MS = '0';
process.env.STEP_TIMEOUT_MS = '15000';
process.env.OTP_PORT = '8799';
process.env.OTP_TIMEOUT_MS = '60000';
process.env.PROFILE_DIR = path.join(tmp, 'profile');
process.env.CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const portal = await startMockPortal();
process.env.SHOPWISE_URL = portal.url;

const { config, loadSelectors } = await import('../src/config.js');
const { runPurchase } = await import('../src/flow.js');
const { openRunLog, closeRunLog } = await import('../src/log.js');

const vault = {
  portalUsername: 'testuser',
  portalPassword: 'testpass',
  cardNumber: portal.card.number,
  cardExpMonth: '12',
  cardExpYear: '30',
  cardCvv: portal.card.cvv,
  cardName: 'A CARDHOLDER',
};

/**
 * Stands in for you typing the OTP into the phone. The relay consumes otp.txt and
 * deletes it, so re-writing on an interval answers both the login and payment
 * prompts without the test needing to know when they happen.
 */
function autoAnswerOtp() {
  const timer = setInterval(() => {
    try {
      if (!fs.existsSync(config.otpFile)) fs.writeFileSync(config.otpFile, portal.otp);
    } catch {
      /* ignore */
    }
  }, 250);
  return () => {
    clearInterval(timer);
    fs.rmSync(config.otpFile, { force: true });
  };
}

const freshProfile = () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
};

test.after(async () => {
  await portal.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('dry run stops at the cart without paying', { timeout: 180_000 }, async () => {
  freshProfile();
  const stop = autoAnswerOtp();
  try {
    const result = await runPurchase({
      vault,
      selectors: loadSelectors(),
      live: false,
      runDir: path.join(tmp, 'dry'),
    });
    assert.equal(result.status, 'dry-run');
    assert.equal(result.total, 1000);
    assert.equal(portal.state.payment, null, 'a dry run must never reach the payment endpoint');
  } finally {
    stop();
  }
});

test('live run completes the purchase end to end', { timeout: 180_000 }, async () => {
  freshProfile();
  portal.state.payment = null;
  const stop = autoAnswerOtp();
  openRunLog(path.join(tmp, 'live'));
  try {
    const result = await runPurchase({
      vault,
      selectors: loadSelectors(),
      live: true,
      runDir: path.join(tmp, 'live'),
    });

    assert.equal(result.status, 'success');
    assert.equal(result.total, 1000);
    assert.match(result.orderId, /SW\d+/);

    // The right ₹1,000 denomination reached the cart...
    assert.equal(portal.state.cart, 1000);
    // ...and the card details arrived intact through the gateway iframe.
    assert.equal(portal.state.payment.number, portal.card.number);
    assert.equal(portal.state.payment.cvv, portal.card.cvv);
    assert.equal(portal.state.payment.expiry, '1230');
    assert.equal(portal.state.payment.name, 'A CARDHOLDER');
  } finally {
    closeRunLog();
    stop();
  }
});

test('a wrong order total aborts before payment', { timeout: 180_000 }, async () => {
  freshProfile();
  portal.state.payment = null;
  portal.state.amountTampered = true;
  const stop = autoAnswerOtp();
  try {
    await assert.rejects(
      runPurchase({
        vault,
        selectors: loadSelectors(),
        live: true,
        runDir: path.join(tmp, 'tampered'),
      }),
      /Order total is 1500 but expected 1000/,
    );
    assert.equal(portal.state.payment, null, 'the guardrail must stop the card ever being sent');
  } finally {
    portal.state.amountTampered = false;
    stop();
  }
});

test('the live run leaks nothing sensitive into its artifacts', { timeout: 60_000 }, async () => {
  const runDir = path.join(tmp, 'live');
  const logFile = path.join(runDir, 'run.log');
  assert.ok(fs.existsSync(logFile), 'the live run should have written a log');

  const contents = fs.readFileSync(logFile, 'utf8');
  assert.ok(!contents.includes(portal.card.number), 'card number must not appear in the log');
  assert.ok(!contents.includes(portal.card.cvv), 'CVV must not appear in the log');
  assert.ok(!contents.includes(portal.otp), 'OTP must not appear in the log');
  assert.ok(!contents.includes(vault.portalPassword), 'password must not appear in the log');

  // And the flow should have captured the screenshots needed to debug a failure.
  const shots = fs.readdirSync(runDir).filter((f) => f.endsWith('.png'));
  assert.ok(shots.includes('03-payment.png'), `expected a payment screenshot, got ${shots}`);
  assert.ok(shots.includes('04-confirmed.png'), `expected a confirmation screenshot, got ${shots}`);
});
