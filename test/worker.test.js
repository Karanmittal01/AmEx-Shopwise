import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startMockPortal } from './mock-portal.js';
import { startMockApp } from './mock-app.js';

/**
 * The worker driving a real purchase while taking its instructions — and both
 * OTPs — from the web app instead of a terminal. This is the seam that spans the
 * two repositories, so it is the one most worth testing.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shopwise-worker-'));
const TOKEN = 'test-worker-token-long-enough-to-pass';

process.env.AMOUNT = '1000';
process.env.SEARCH_TERM = 'Amazon Pay';
process.env.HEADLESS = 'true';
process.env.SLOW_MO_MS = '0';
process.env.STEP_TIMEOUT_MS = '15000';
process.env.OTP_TIMEOUT_MS = '60000';
process.env.OTP_POLL_MS = '250';
process.env.PROFILE_DIR = path.join(tmp, 'profile');
process.env.RUNS_DIR = path.join(tmp, 'runs');
process.env.WORKER_TOKEN = TOKEN;
process.env.CHROMIUM_PATH =
  process.env.CHROMIUM_PATH || '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

const portal = await startMockPortal();
process.env.SHOPWISE_URL = portal.url;

const app = await startMockApp({
  token: TOKEN,
  job: { id: 'job_test_1', mode: 'live', faceValueCents: 100_000 },
});
process.env.APP_URL = app.url;

const { config, loadSelectors } = await import('../src/config.js');
const { claimJob } = await import('../src/remote.js');
const { handleJob } = await import('../src/worker.js');

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

/** Answers whichever OTP the worker is currently asking the app for. */
function autoAnswerViaApp() {
  const timer = setInterval(() => {
    if (app.state.job.status === 'AWAITING_OTP') app.submitOtp(portal.otp);
  }, 200);
  return () => clearInterval(timer);
}

test.after(async () => {
  await Promise.all([portal.close(), app.close()]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('the worker claims a job, buys, and reports back', { timeout: 240_000 }, async () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
  const stop = autoAnswerViaApp();

  try {
    const job = await claimJob();
    assert.ok(job, 'the worker should have claimed the queued job');
    assert.equal(job.id, 'job_test_1');
    assert.equal(job.mode, 'live');

    await handleJob(job, vault, loadSelectors());

    // Both OTPs were asked for through the app — login, then payment.
    assert.equal(app.state.otpRequests.length, 2, `got ${JSON.stringify(app.state.otpRequests)}`);
    assert.match(app.state.otpRequests[0], /login/i);
    assert.match(app.state.otpRequests[1], /1017\.7|gift card/i);

    // Progress reached the page, so the UI has something to show.
    const phases = app.state.progress.map((p) => p.phase);
    assert.ok(phases.includes('logging-in'), `phases: ${phases}`);
    assert.ok(phases.includes('verified'), `phases: ${phases}`);
    assert.ok(phases.includes('paying'), `phases: ${phases}`);

    // The finish report carries the real charge, in paise, fee included.
    assert.equal(app.state.finished.status, 'succeeded');
    assert.equal(app.state.finished.totalPaise, 101_770);
    assert.equal(app.state.finished.feePaise, 1_770);
    assert.match(app.state.finished.orderRef, /SW\d+/);

    // And the purchase really happened at the portal.
    assert.equal(portal.state.payment.number, portal.card.number);
  } finally {
    stop();
  }
});

test('a failure is reported to the app rather than swallowed', { timeout: 240_000 }, async () => {
  fs.rmSync(config.profileDir, { recursive: true, force: true });
  app.state.job.status = 'QUEUED';
  app.state.finished = null;
  app.state.otpRequests.length = 0;
  portal.state.payment = null;
  portal.state.amountTampered = true; // pushes the total past the ceiling

  const stop = autoAnswerViaApp();
  try {
    const job = await claimJob();
    await handleJob(job, vault, loadSelectors());

    assert.equal(app.state.finished.status, 'failed');
    assert.match(app.state.finished.error, /exceeds the ceiling/);
    assert.equal(portal.state.payment, null, 'the card must never have been submitted');

    // The reported error must not carry anything sensitive back to the server.
    assert.ok(!app.state.finished.error.includes(portal.card.number));
    assert.ok(!app.state.finished.error.includes(portal.card.cvv));
  } finally {
    portal.state.amountTampered = false;
    stop();
  }
});
