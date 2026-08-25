import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Minimal .env loader so the project stays dependency-free apart from Playwright. */
function loadDotEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

loadDotEnv();

const num = (v, fallback) => (v === undefined || v === '' ? fallback : Number(v));
const bool = (v, fallback) => (v === undefined || v === '' ? fallback : /^(1|true|yes)$/i.test(v));

export const config = {
  /** Portal entry point. */
  baseUrl: process.env.SHOPWISE_URL || 'https://shopwise.giftstacc.com/',

  /** What to buy. `amount` is the gift card's face value, before fees. */
  searchTerm: process.env.SEARCH_TERM || 'Amazon Pay',
  amount: num(process.env.AMOUNT, 1000),
  currencySymbol: process.env.CURRENCY_SYMBOL || '₹',

  /**
   * The portal adds a convenience fee plus GST on top of the face value, so the
   * amount actually charged is more than `amount`:
   *
   *   fee   = (faceValue − discount) × feePercent/100 × (1 + gstPercent/100)
   *   total = faceValue + fee
   *
   * For a ₹1,000 card at 1.5% + 18% GST that is ₹17.70, so ₹1,017.70 is charged.
   * These percentages come from the portal's API at runtime, so the flow reads
   * the real total off the page — these values only set the ceiling it is
   * allowed to fall under.
   */
  feePercent: num(process.env.FEE_PERCENT, 1.5),
  gstPercent: num(process.env.GST_PERCENT, 18),
  /** Slack above the computed total, for rounding differences. */
  feeToleranceRupees: num(process.env.FEE_TOLERANCE, 2),

  /**
   * Absolute ceiling on what may be paid. Leave unset to derive it from the fee
   * percentages above, which is the safer default because it moves with AMOUNT.
   */
  maxAmountOverride: process.env.MAX_AMOUNT ? Number(process.env.MAX_AMOUNT) : null,

  /** Total number of monthly purchases before the schedule retires itself. */
  totalRuns: num(process.env.TOTAL_RUNS, 6),

  /** OTP relay. */
  otpPort: num(process.env.OTP_PORT, 8787),
  otpTimeoutMs: num(process.env.OTP_TIMEOUT_MS, 6 * 60 * 1000),
  otpFile: path.join(ROOT, 'otp.txt'),
  otpPollMs: num(process.env.OTP_POLL_MS, 2000),

  /**
   * Worker mode: where the Splitwise Killer Tools page lives, and the shared
   * secret that authenticates this worker to it.
   */
  appUrl: process.env.APP_URL || '',
  workerToken: process.env.WORKER_TOKEN || '',
  pollIntervalMs: num(process.env.POLL_INTERVAL_MS, 15_000),

  /** Browser. */
  headless: bool(process.env.HEADLESS, true),
  slowMoMs: num(process.env.SLOW_MO_MS, 120),
  navTimeoutMs: num(process.env.NAV_TIMEOUT_MS, 60_000),
  stepTimeoutMs: num(process.env.STEP_TIMEOUT_MS, 30_000),
  profileDir: process.env.PROFILE_DIR || path.join(ROOT, 'browser-profile'),

  /**
   * Path to a Chromium binary. Leave unset to use the one Playwright downloads.
   * On Termux/ARM there is no Playwright download, so point this at the system
   * chromium (`pkg install chromium`, then `which chromium`).
   */
  executablePath: process.env.CHROMIUM_PATH || undefined,

  /** Optional upstream proxy, e.g. http://127.0.0.1:8080. Rarely needed. */
  proxyServer: process.env.PROXY_SERVER || undefined,
  ignoreHttpsErrors: bool(process.env.IGNORE_HTTPS_ERRORS, false),

  /** Paths. */
  vaultFile: path.join(ROOT, 'vault.enc'),
  stateFile: path.join(ROOT, 'state.json'),
  runsDir: process.env.RUNS_DIR || path.join(ROOT, 'runs'),
  selectorsFile: path.join(ROOT, 'src', 'selectors.json'),
};

/**
 * The fee the portal is expected to add, and the highest total the flow may pay.
 * Exported so the UI can show the expected charge before anything is spent.
 */
export function expectedCharge(faceValue = config.amount) {
  const fee = faceValue * (config.feePercent / 100) * (1 + config.gstPercent / 100);
  const total = faceValue + fee;
  const ceiling =
    config.maxAmountOverride !== null
      ? config.maxAmountOverride
      : total + config.feeToleranceRupees;
  return {
    faceValue,
    fee: round2(fee),
    total: round2(total),
    ceiling: round2(ceiling),
    // Below this the cart almost certainly holds the wrong denomination.
    floor: round2(faceValue * 0.8),
  };
}

const round2 = (n) => Math.round(n * 100) / 100;

export function loadSelectors() {
  const raw = fs.readFileSync(config.selectorsFile, 'utf8');
  const parsed = JSON.parse(raw);
  const overrideFile = path.join(ROOT, 'selectors.local.json');
  if (fs.existsSync(overrideFile)) {
    const override = JSON.parse(fs.readFileSync(overrideFile, 'utf8'));
    for (const [key, value] of Object.entries(override)) {
      // A local override replaces the shipped candidates for that step outright,
      // so calibration always wins over the guessed defaults.
      parsed[key] = value;
    }
  }
  return parsed;
}
