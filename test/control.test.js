import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockPortal } from './mock-portal.js';

/**
 * The simple path, exercised the way it is actually used: the control page is
 * the only interface. Tap Buy, answer two OTPs, read the result — all over HTTP,
 * with no database, no token and no second process involved.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopwise-control-'));

process.env.AMOUNT = '1000';
process.env.HEADLESS = 'true';
process.env.SLOW_MO_MS = '0';
process.env.STEP_TIMEOUT_MS = '15000';
process.env.OTP_PORT = '8791';
process.env.PROFILE_DIR = path.join(tmp, 'profile');
process.env.RUNS_DIR = path.join(tmp, 'runs');
process.env.CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const portal = await startMockPortal();
process.env.SHOPWISE_URL = portal.url;

const { config, loadSelectors } = await import('../src/config.js');
const { startControlServer } = await import('../src/control.js');
const { runPurchase } = await import('../src/flow.js');
const { setOtpProvider } = await import('../src/otp.js');

const vault = {
  portalMobile: portal.mobile,
  cardNumber: portal.card.number,
  cardExpMonth: '12',
  cardExpYear: '30',
  cardCvv: portal.card.cvv,
  cardName: 'A CARDHOLDER',
};

// Each test gets its own port: a just-closed listener can linger long enough to
// make the next bind fail, and that has nothing to do with what is being tested.
let nextPort = config.otpPort;
const portFor = () => nextPort++;
let base = `http://127.0.0.1:${config.otpPort}`;
const getState = async () => (await fetch(`${base}/state`, { cache: 'no-store' })).json();
const post = (path, body) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

test.after(async () => {
  await portal.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the whole purchase runs from the phone page', { timeout: 240_000 }, async () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
  const port = portFor();
  base = `http://127.0.0.1:${port}`;
  const control = await startControlServer({ port, amount: 1000 });
  setOtpProvider(control.requestOtp);

  try {
    // The page is up and offering the two buttons before anything happens.
    assert.equal((await getState()).stage, 'idle');
    assert.ok((await (await fetch(base)).text()).includes('Buy'), 'the page should offer a Buy button');

    // Tap Buy.
    const started = control.waitForStart();
    await post('/start', { mode: 'live' });
    assert.equal(await started, 'live');

    // Answer whichever OTP the page is asking for, as it asks.
    const answering = setInterval(async () => {
      const state = await getState().catch(() => null);
      if (state?.otp.pending) await post('/otp', { code: portal.otp }).catch(() => {});
    }, 200);

    const result = await runPurchase({
      vault,
      selectors: loadSelectors(),
      live: true,
      runDir: path.join(tmp, 'run'),
      onProgress: async (update) => control.setPhase(update),
    });
    clearInterval(answering);
    control.finish(result);

    assert.equal(result.status, 'success');
    assert.equal(result.total, 1017.7);

    // The page ends up showing the outcome, not a spinner.
    const final = await getState();
    assert.equal(final.stage, 'done');
    assert.equal(final.total, 1017.7);
    assert.match(final.orderId, /SW\d+/);
    assert.equal(final.otp.pending, false);
  } finally {
    setOtpProvider(null);
    await control.close();
  }
});

test('the page rejects anything that is not an OTP', { timeout: 60_000 }, async () => {
  const port = portFor();
  base = `http://127.0.0.1:${port}`;
  const control = await startControlServer({ port, amount: 1000 });
  try {
    for (const code of ['', 'abcdef', '12', '1234567890']) {
      const response = await post('/otp', { code });
      assert.equal(response.status, 400, `"${code}" should have been rejected`);
    }
  } finally {
    await control.close();
  }
});

test('a failure is shown on the page rather than leaving it spinning', { timeout: 240_000 }, async () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
  portal.state.payment = null;
  portal.state.amountTampered = true;

  const port = portFor();
  base = `http://127.0.0.1:${port}`;
  const control = await startControlServer({ port, amount: 1000 });
  setOtpProvider(control.requestOtp);
  const answering = setInterval(async () => {
    const state = await getState().catch(() => null);
    if (state?.otp.pending) await post('/otp', { code: portal.otp }).catch(() => {});
  }, 200);

  try {
    await post('/start', { mode: 'live' });
    await assert.rejects(
      runPurchase({
        vault,
        selectors: loadSelectors(),
        live: true,
        runDir: path.join(tmp, 'fail'),
        onProgress: async (update) => control.setPhase(update),
      }),
      /exceeds the ceiling/,
    );
    control.finish({ error: 'Order total exceeds the ceiling.' });

    const final = await getState();
    assert.equal(final.stage, 'failed');
    assert.match(final.error, /ceiling/);
    assert.equal(portal.state.payment, null, 'the card must never have been submitted');
  } finally {
    clearInterval(answering);
    portal.state.amountTampered = false;
    setOtpProvider(null);
    await control.close();
  }
});
