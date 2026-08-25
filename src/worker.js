import path from 'node:path';
import { config, loadSelectors, expectedCharge } from './config.js';
import { log, openRunLog, closeRunLog, maskCard, redact } from './log.js';
import { loadVault } from './vault.js';
import { runPurchase } from './flow.js';
import { setOtpProvider } from './otp.js';
import { claimJob, reportProgress, finishJob, requestOtpFromApp, sleep } from './remote.js';
import { recordRun } from './state.js';

/**
 * Long-running worker. Polls the web app for queued purchases, runs them, and
 * reports back.
 *
 * One job at a time, deliberately: two concurrent Chromium sessions logging into
 * the same portal account would fight over the session, and there is never more
 * than one purchase due anyway.
 */
export async function runWorker() {
  const vault = await loadVault();
  const selectors = loadSelectors();

  log.info(`worker started — polling ${config.appUrl} every ${config.pollIntervalMs / 1000}s`);
  log.info(`card ${maskCard(vault.cardNumber)}, ${config.currencySymbol}${config.amount} face value`);

  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    log.info('shutting down after the current job…');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  while (!stopping) {
    let job = null;
    try {
      job = await claimJob();
    } catch (err) {
      // A web app that is redeploying, asleep, or briefly unreachable is normal.
      log.warn(`could not reach the web app: ${err.message}`);
    }

    if (!job) {
      await sleep(config.pollIntervalMs);
      continue;
    }

    await handleJob(job, vault, selectors);
  }

  log.info('worker stopped');
}

export async function handleJob(job, vault, selectors) {
  const runDir = path.join(config.runsDir, `job-${job.id}`);
  openRunLog(runDir);

  const live = job.mode === 'live';
  log.info(`job ${job.id}: ${live ? 'LIVE' : 'DRY RUN'}, ${config.currencySymbol}${config.amount}`);

  // OTPs for this job come from the Tools page rather than a local terminal.
  setOtpProvider(requestOtpFromApp(job.id));

  try {
    const result = await runPurchase({
      vault,
      selectors,
      live,
      runDir,
      onProgress: (update) => reportProgress(job.id, update),
    });

    if (result.status === 'success') {
      recordRun({
        status: 'success',
        total: result.total,
        fee: result.fee,
        orderId: result.orderId,
      });
    }

    await finishJob(job.id, {
      status: result.status === 'success' ? 'succeeded' : 'dry_run',
      totalPaise: toPaise(result.total),
      feePaise: toPaise(result.fee),
      orderRef: result.orderId ?? null,
    });
    log.info(`job ${job.id} finished: ${result.status}`);
  } catch (err) {
    log.error(`job ${job.id} failed:`, err);
    if (live) recordRun({ status: 'failed', error: String(err.message || err) });
    await finishJob(job.id, {
      status: 'failed',
      // Scrub before it leaves this machine: an error can quote a page's contents.
      error: redact(String(err.message || err)).slice(0, 1000),
    }).catch((sendErr) => log.error('could not report the failure:', sendErr.message));
  } finally {
    setOtpProvider(null);
    closeRunLog();
  }
}

/** The web app stores money as integer paise, like the rest of Splitwise Killer. */
const toPaise = (rupees) =>
  typeof rupees === 'number' && Number.isFinite(rupees) ? Math.round(rupees * 100) : null;

export { expectedCharge };
