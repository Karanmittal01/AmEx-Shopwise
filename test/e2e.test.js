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
// Deliberately NOT setting MAX_AMOUNT: the ceiling should be derived from the fee
// percentages, which is what makes room for the ₹17.70 the portal adds.
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

const { config, loadSelectors, expectedCharge } = await import('../src/config.js');
const { runPurchase } = await import('../src/flow.js');
const { openRunLog, closeRunLog } = await import('../src/log.js');

const vault = {
  portalMobile: portal.mobile,
  portalEmail: '',
  portalPassword: '',
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
    // The face value is ₹1,000 but the charge includes the fee: ₹1,017.70.
    assert.equal(result.faceValue, 1000);
    assert.equal(result.total, 1017.7);
    assert.equal(result.fee, 17.7);
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
    assert.equal(result.total, 1017.7);
    assert.equal(result.fee, 17.7);
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

test('a total above the fee ceiling aborts before payment', { timeout: 180_000 }, async () => {
  freshProfile();
  portal.state.payment = null;
  portal.state.amountTampered = true; // ₹1,500 face value → ₹1,526.55 charged
  const stop = autoAnswerOtp();
  try {
    await assert.rejects(
      runPurchase({
        vault,
        selectors: loadSelectors(),
        live: true,
        runDir: path.join(tmp, 'tampered'),
      }),
      /exceeds the ceiling/,
    );
    assert.equal(portal.state.payment, null, 'the guardrail must stop the card ever being sent');
  } finally {
    portal.state.amountTampered = false;
    stop();
  }
});

test('the real convenience fee is accepted, not treated as tampering', () => {
  // The regression that mattered: asserting total === faceValue aborted every run,
  // because the portal always charges the fee on top.
  const expect = expectedCharge(1000);
  assert.equal(expect.total, 1017.7);
  assert.ok(portal.feeFor(1000) + 1000 <= expect.ceiling, 'the real fee must sit under the ceiling');
  assert.ok(expect.ceiling < 1100, 'the ceiling must still be tight enough to be worth having');
});

test('the live run leaks nothing sensitive into its artifacts', { timeout: 60_000 }, async () => {
  const runDir = path.join(tmp, 'live');
  const logFile = path.join(runDir, 'run.log');
  assert.ok(fs.existsSync(logFile), 'the live run should have written a log');

  const contents = fs.readFileSync(logFile, 'utf8');
  assert.ok(!contents.includes(portal.card.number), 'card number must not appear in the log');
  assert.ok(!contents.includes(portal.card.cvv), 'CVV must not appear in the log');
  assert.ok(!contents.includes(portal.otp), 'OTP must not appear in the log');
  if (vault.portalPassword) {
    assert.ok(!contents.includes(vault.portalPassword), 'password must not appear in the log');
  }

  // And the flow should have captured the screenshots needed to debug a failure.
  const shots = fs.readdirSync(runDir).filter((f) => f.endsWith('.png'));
  assert.ok(shots.includes('03-payment.png'), `expected a payment screenshot, got ${shots}`);
  assert.ok(shots.includes('04-confirmed.png'), `expected a confirmation screenshot, got ${shots}`);
});
