import { config } from './config.js';
import { log } from './log.js';

/**
 * Client for the Splitwise Killer Tools API.
 *
 * The worker always calls *out* to the web app — it never listens. That is what
 * lets it sit on a Raspberry Pi behind a home router, or on a laptop, with no
 * port forwarding, no public IP and no TLS certificate of its own. It also means
 * the card vault stays on this machine: the web app is told about amounts, order
 * IDs and progress, and never sees a card number.
 */

class HttpError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}: ${String(body).slice(0, 300)}`);
    this.status = status;
  }
}

async function api(path, { method = 'GET', body, timeoutMs = 20_000 } = {}) {
  if (!config.appUrl) throw new Error('APP_URL is not set — the worker cannot reach the web app.');
  if (!config.workerToken) throw new Error('WORKER_TOKEN is not set.');

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(path, config.appUrl), {
      method,
      headers: {
        authorization: `Bearer ${config.workerToken}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });

    const text = await response.text();
    if (!response.ok) throw new HttpError(response.status, text);
    return text ? JSON.parse(text) : null;
  } finally {
    clearTimeout(timer);
  }
}

/** Claims the next queued job, or null when there is nothing to do. */
export async function claimJob() {
  const result = await api('/api/tools/shopwise/jobs/next', { method: 'POST' });
  return result?.job ?? null;
}

export async function reportProgress(jobId, update) {
  await api(`/api/tools/shopwise/jobs/${jobId}/progress`, { method: 'POST', body: update });
}

export async function finishJob(jobId, result) {
  await api(`/api/tools/shopwise/jobs/${jobId}/finish`, { method: 'POST', body: result });
}

/**
 * Asks the web app for an OTP and waits for you to type it into the Tools page.
 *
 * Polling rather than a push channel: it survives the worker restarting, needs no
 * websocket through whatever proxy sits in front of the app, and a few seconds of
 * latency is irrelevant next to the time it takes to read a text message.
 */
export function requestOtpFromApp(jobId) {
  return async (purpose) => {
    await api(`/api/tools/shopwise/jobs/${jobId}/otp/request`, {
      method: 'POST',
      body: { purpose },
    });

    const deadline = Date.now() + config.otpTimeoutMs;
    while (Date.now() < deadline) {
      await sleep(config.otpPollMs);
      const { code, cancelled } = await api(`/api/tools/shopwise/jobs/${jobId}/otp`);
      if (cancelled) throw new Error('Cancelled from the web app while waiting for the OTP.');
      if (code) {
        log.info('received OTP from the web app');
        return code;
      }
    }
    throw new Error(
      `No OTP arrived within ${Math.round(config.otpTimeoutMs / 1000)}s — giving up on this run.`,
    );
  };
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
