#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { config, loadSelectors, ROOT } from './config.js';
import { log, openRunLog, closeRunLog, registerSecret, maskCard } from './log.js';
import { ask, askRequired, confirm } from './prompt.js';
import { saveVault, loadVault, vaultExists } from './vault.js';
import { runPurchase, launchBrowser } from './flow.js';
import { loadState, saveState, isDue, recordRun, successfulRuns, monthKey } from './state.js';

const USAGE = `
Amex Shopwise — Amazon Pay gift card autobuy

  node src/index.js setup             Store portal login + card details (encrypted)
  node src/index.js calibrate [url]   Open a page and dump its selectors, to fix selectors.local.json
  node src/index.js run [options]     Run the purchase flow
  node src/index.js status            Show progress through the ${config.totalRuns} monthly purchases
  node src/index.js reset             Clear the run history (does not touch the vault)

run options:
  --live        Actually pay. Without it the run stops at the cart (dry run).
  --if-due      Do nothing unless a purchase is due this month. Use this in cron.
  --headful     Show the browser window. Recommended for the first run.
`;

const args = process.argv.slice(2);
const command = args[0];
const has = (flag) => args.includes(flag);

async function cmdSetup() {
  console.log('\nStoring credentials. Everything is encrypted with AES-256-GCM at rest.');
  console.log('Nothing is echoed to the screen, and nothing is ever logged.\n');

  if (vaultExists() && !(await confirm('A vault already exists. Overwrite it?'))) {
    return;
  }

  const data = {
    portalUsername: await askRequired('Shopwise user ID / mobile: '),
    portalPassword: await askRequired('Shopwise password: ', { hidden: true }),
    cardNumber: (await askRequired('Card number: ', { hidden: true })).replace(/\D/g, ''),
    cardExpMonth: (await askRequired('Expiry month (MM): ')).padStart(2, '0'),
    cardExpYear: await askRequired('Expiry year (YY or YYYY): '),
    cardCvv: await askRequired('CVV: ', { hidden: true }),
    cardName: await ask('Name on card (blank to skip): '),
  };

  for (const key of ['portalPassword', 'cardNumber', 'cardCvv']) registerSecret(data[key]);

  if (!/^\d{12,19}$/.test(data.cardNumber)) {
    throw new Error('That card number does not look right (expected 12-19 digits).');
  }
  if (!/^\d{3,4}$/.test(data.cardCvv)) {
    throw new Error('That CVV does not look right (expected 3 or 4 digits).');
  }

  console.log('\nChoose a passphrase to encrypt the vault.');
  const passphrase = await askRequired('Passphrase: ', { hidden: true });
  const again = await askRequired('Confirm passphrase: ', { hidden: true });
  if (passphrase !== again) throw new Error('Passphrases do not match.');

  saveVault(data, passphrase);
  console.log(`\nSaved ${config.vaultFile} (mode 0600) for card ${maskCard(data.cardNumber)}.`);

  console.log(
    '\nFor unattended monthly runs the script needs the passphrase without you there.',
  );
  if (await confirm('Write the passphrase to ./vault.key (chmod 600) so cron can run?')) {
    fs.writeFileSync(path.join(ROOT, 'vault.key'), passphrase, { mode: 0o600 });
    fs.chmodSync(path.join(ROOT, 'vault.key'), 0o600);
    console.log('Wrote vault.key. Both vault.enc and vault.key are gitignored — keep them that way.');
  } else {
    console.log('Skipped. Set SHOPWISE_VAULT_PASS in the environment when running from cron.');
  }
}

async function cmdCalibrate() {
  const url = args[1] || config.baseUrl;
  const context = await launchBrowser();
  const page = context.pages()[0] || (await context.newPage());
  await page.goto(url, { waitUntil: 'domcontentloaded' });

  const inventory = [];
  for (const frame of page.frames()) {
    const items = await frame
      .evaluate(() => {
        const sel = 'a,button,input,select,textarea,[role="button"],[role="link"],[data-testid]';
        return [...document.querySelectorAll(sel)]
          .filter((el) => el.getBoundingClientRect().width > 0)
          .slice(0, 300)
          .map((el) => ({
            tag: el.tagName.toLowerCase(),
            type: el.getAttribute('type') || undefined,
            id: el.id || undefined,
            name: el.getAttribute('name') || undefined,
            testid: el.getAttribute('data-testid') || undefined,
            placeholder: el.getAttribute('placeholder') || undefined,
            ariaLabel: el.getAttribute('aria-label') || undefined,
            role: el.getAttribute('role') || undefined,
            text: (el.innerText || el.value || '').trim().slice(0, 60) || undefined,
          }));
      })
      .catch(() => []);
    if (items.length) inventory.push({ frame: frame.url(), items });
  }

  fs.mkdirSync(config.runsDir, { recursive: true });
  const out = path.join(config.runsDir, `calibrate-${Date.now()}.json`);
  fs.writeFileSync(out, JSON.stringify({ url, inventory }, null, 2));
  console.log(`\nWrote ${out}`);
  console.log('Pick the elements you need and add them to selectors.local.json, e.g.');
  console.log('  { "addToCart": ["css=#buy-now", "role=button|Buy now"] }\n');

  if (!config.headless) {
    await ask('Browser is open — navigate around, then press Enter to close. ');
  }
  await context.close();
}

async function cmdRun() {
  const live = has('--live');
  if (has('--headful')) config.headless = false;

  const state = loadState();
  if (has('--if-due')) {
    const { due, reason } = isDue(state);
    if (!due) {
      console.log(`Nothing to do — ${reason}.`);
      return;
    }
    log.info(`due: ${reason}`);
  }

  const runDir = path.join(config.runsDir, new Date().toISOString().replace(/[:.]/g, '-'));
  openRunLog(runDir);

  try {
    const vault = await loadVault(() => askRequired('Vault passphrase: ', { hidden: true }));
    const selectors = loadSelectors();

    log.info(
      `${live ? 'LIVE' : 'DRY RUN'} — ${config.currencySymbol}${config.amount} ` +
        `${config.searchTerm} gift card, card ${maskCard(vault.cardNumber)}`,
    );
    if (!live) log.info('No payment will be submitted. Add --live when the flow looks right.');

    const result = await runPurchase({ vault, selectors, live, runDir });

    if (result.status === 'success') {
      const updated = recordRun({ status: 'success', total: result.total, orderId: result.orderId });
      const done = successfulRuns(updated).length;
      log.info(`purchase ${done} of ${config.totalRuns} recorded`);
      if (done >= config.totalRuns) {
        log.info('That was the last scheduled purchase. Remove the cron entry when convenient.');
      }
    }
  } catch (err) {
    log.error(err);
    if (live) recordRun({ status: 'failed', error: String(err.message || err) });
    log.error(`Run artifacts (screenshots + log) are in ${runDir}`);
    process.exitCode = 1;
  } finally {
    closeRunLog();
  }
}

function cmdStatus() {
  const state = loadState();
  const done = successfulRuns(state);
  const { due, reason } = isDue(state);

  console.log(`\nProgress: ${done.length} of ${config.totalRuns} monthly purchases`);
  console.log(`This month (${monthKey()}): ${due ? `due — ${reason}` : reason}\n`);

  if (state.runs.length === 0) {
    console.log('No runs recorded yet.');
    return;
  }
  for (const run of state.runs) {
    const detail =
      run.status === 'success'
        ? `${config.currencySymbol}${run.total}${run.orderId ? ` — ${run.orderId}` : ''}`
        : run.error || '';
    console.log(`  ${run.month}  ${run.at}  ${run.status.padEnd(8)}  ${detail}`);
  }
  console.log('');
}

async function cmdReset() {
  if (!(await confirm('Clear the run history and start the six months over?'))) return;
  saveState({ runs: [], createdAt: new Date().toISOString() });
  console.log('Run history cleared. The vault is untouched.');
}

const commands = {
  setup: cmdSetup,
  calibrate: cmdCalibrate,
  run: cmdRun,
  status: cmdStatus,
  reset: cmdReset,
};

const handler = commands[command];
if (!handler) {
  console.log(USAGE);
  process.exit(command ? 1 : 0);
}

// Promise.resolve() so synchronous commands (status) are handled the same way.
Promise.resolve()
  .then(handler)
  .catch((err) => {
    console.error(`\nError: ${err.message}\n`);
    process.exit(1);
  });
