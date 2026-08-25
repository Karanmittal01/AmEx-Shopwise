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
  /** Portal entry point. Override in .env if the portal moves. */
  baseUrl: process.env.SHOPWISE_URL || 'https://www.amexshopwise.com/',

  /** What to buy. */
  searchTerm: process.env.SEARCH_TERM || 'Amazon Pay',
  amount: num(process.env.AMOUNT, 1000),
  currencySymbol: process.env.CURRENCY_SYMBOL || '₹',

  /**
   * Hard ceiling. The flow reads the real order total off the checkout page and
   * refuses to pay if it exceeds this. Keep it tight.
   */
  maxAmount: num(process.env.MAX_AMOUNT, num(process.env.AMOUNT, 1000)),

  /** Total number of monthly purchases before the schedule retires itself. */
  totalRuns: num(process.env.TOTAL_RUNS, 6),

  /** OTP relay. */
  otpPort: num(process.env.OTP_PORT, 8787),
  otpTimeoutMs: num(process.env.OTP_TIMEOUT_MS, 6 * 60 * 1000),
  otpFile: path.join(ROOT, 'otp.txt'),

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

  /** Paths. */
  vaultFile: path.join(ROOT, 'vault.enc'),
  stateFile: path.join(ROOT, 'state.json'),
  runsDir: path.join(ROOT, 'runs'),
  selectorsFile: path.join(ROOT, 'src', 'selectors.json'),
};

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
