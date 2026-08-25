import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAmount } from '../src/flow.js';
import { encryptVault, decryptVault } from '../src/vault.js';
import { isDue, monthKey } from '../src/state.js';
import { redact, registerSecret, maskCard } from '../src/log.js';

test('parseAmount handles the formats an Indian portal actually renders', () => {
  assert.equal(parseAmount('₹1,000.00'), 1000);
  assert.equal(parseAmount('Rs. 1000'), 1000);
  assert.equal(parseAmount('INR 1,000'), 1000);
  assert.equal(parseAmount('Total payable ₹1,000'), 1000);
  assert.equal(parseAmount('₹10,000'), 10000);
  assert.equal(parseAmount('free'), null);
  assert.equal(parseAmount(''), null);
  assert.equal(parseAmount(null), null);
});

test('vault round-trips and rejects the wrong passphrase', () => {
  const secret = { cardNumber: '4111111111111111', cardCvv: '123' };
  const blob = encryptVault(secret, 'correct horse');

  assert.ok(!blob.includes('4111111111111111'), 'plaintext must not survive in the file');
  assert.deepEqual(decryptVault(blob, 'correct horse'), secret);
  assert.throws(() => decryptVault(blob, 'wrong passphrase'));
});

test('vault tampering is detected by the GCM tag', () => {
  const blob = encryptVault({ cardCvv: '123' }, 'pass');
  const payload = JSON.parse(blob);
  const bytes = Buffer.from(payload.data, 'base64');
  bytes[0] ^= 0xff;
  payload.data = bytes.toString('base64');
  assert.throws(() => decryptVault(JSON.stringify(payload), 'pass'));
});

test('scheduler allows one purchase per month, six in total', () => {
  const now = new Date('2026-09-15T00:00:00Z');
  const thisMonth = monthKey(now);

  assert.equal(isDue({ runs: [] }, now).due, true);

  const alreadyBought = { runs: [{ status: 'success', month: thisMonth }] };
  assert.equal(isDue(alreadyBought, now).due, false);

  // A failed attempt this month must not block a retry.
  const failedOnly = { runs: [{ status: 'failed', month: thisMonth }] };
  assert.equal(isDue(failedOnly, now).due, true);

  const sixDone = {
    runs: ['2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08'].map((month) => ({
      status: 'success',
      month,
    })),
  };
  assert.equal(isDue(sixDone, now).due, false);
  assert.match(isDue(sixDone, now).reason, /already done/);
});

test('log redaction strips registered secrets and card-shaped digits', () => {
  registerSecret('hunter2-portal-password');
  assert.match(redact('login failed for hunter2-portal-password'), /\[redacted\]/);
  assert.ok(!redact('login failed for hunter2-portal-password').includes('hunter2'));

  // Even a number that was never registered — e.g. read back off the page.
  assert.equal(redact('card 4111 1111 1111 1111 declined'), 'card ****1111 declined');
  assert.equal(maskCard('4111111111111111'), '**** **** **** 1111');
});
