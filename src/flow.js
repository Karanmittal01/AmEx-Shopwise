import path from 'node:path';
import { chromium } from 'playwright';
import { config, expectedCharge } from './config.js';
import { log, maskCard } from './log.js';
import { find, findOptional, clickStep, fillStep } from './locate.js';
import { waitForOtp } from './otp.js';

/** CSS that blurs anything sensitive before a screenshot is taken. */
const REDACT_CSS = `
  input[type="password"],
  input[autocomplete="one-time-code"],
  input[name*="card" i], input[id*="card" i],
  input[name*="cvv" i], input[id*="cvv" i],
  input[name*="cvc" i],
  input[name*="otp" i], input[id*="otp" i] {
    filter: blur(6px) !important;
  }`;

/**
 * Screenshots are the main debugging tool for a headless run, but a naive
 * screenshot of a payment page captures the card number. Blur first.
 */
async function safeScreenshot(page, file) {
  const handles = [];
  for (const frame of page.frames()) {
    try {
      handles.push(await frame.addStyleTag({ content: REDACT_CSS }));
    } catch {
      /* cross-origin frame we cannot touch — its own screenshot region stays as-is */
    }
  }
  try {
    await page.screenshot({ path: file, fullPage: true });
    log.info(`screenshot → ${file}`);
  } catch (err) {
    log.warn('screenshot failed:', err.message);
  } finally {
    for (const handle of handles) {
      await handle.evaluate((node) => node.remove()).catch(() => {});
    }
  }
}

/**
 * "₹1,000.00" / "Rs. 1000" / "INR 1,000" → 1000
 *
 * Prefers a number attached to a currency marker, and takes the last one, because
 * the element matched is often a whole summary block ("Sub total ₹1,000
 * Convenience fee ₹17.70 Total ₹1,017.70") where the figure that matters is the
 * final one. Falls back to the first bare number when nothing is marked.
 */
export function parseAmount(text) {
  if (!text) return null;
  const flat = String(text).replace(/\s/g, '');

  const marked = [...flat.matchAll(/(?:₹|Rs\.?|INR)([\d,]+(?:\.\d{1,2})?)/gi)];
  if (marked.length > 0) {
    const value = Number(marked[marked.length - 1][1].replace(/,/g, ''));
    if (Number.isFinite(value)) return value;
  }

  const bare = flat.match(/(\d[\d,]*(?:\.\d{1,2})?)/);
  if (!bare) return null;
  const value = Number(bare[1].replace(/,/g, ''));
  return Number.isFinite(value) ? value : null;
}

export async function launchBrowser() {
  log.info(`launching chromium (headless=${config.headless})`);
  const context = await chromium.launchPersistentContext(config.profileDir, {
    headless: config.headless,
    executablePath: config.executablePath,
    proxy: config.proxyServer ? { server: config.proxyServer } : undefined,
    ignoreHTTPSErrors: config.ignoreHttpsErrors,
    slowMo: config.slowMoMs,
    viewport: { width: 1280, height: 900 },
    locale: 'en-IN',
    timezoneId: 'Asia/Kolkata',
    args: ['--disable-blink-features=AutomationControlled'],
  });
  context.setDefaultTimeout(config.stepTimeoutMs);
  context.setDefaultNavigationTimeout(config.navTimeoutMs);
  return context;
}

/**
 * Signs in.
 *
 * The portal identifies you by mobile number or email and then sends an OTP —
 * there is usually no password at all. So an OTP on every run is the normal path,
 * not the exception; the saved browser profile only helps while its session is
 * still alive. A password field is filled if one happens to be shown and a
 * password is stored, which keeps this working if the portal changes its mind.
 */
async function ensureLoggedIn(page, sel, vault) {
  log.step('checking session');
  const marker = await findOptional(page, 'loggedInMarker', sel.loggedInMarker, { timeout: 8000 });
  if (marker) {
    log.info('already logged in (saved session still valid)');
    return;
  }

  log.step('logging in');
  const loginLink = await findOptional(page, 'loginLink', sel.loginLink, { timeout: 8000 });
  if (loginLink) await loginLink.click();

  const identifier = vault.portalMobile || vault.portalEmail || vault.portalUsername;
  if (!identifier) {
    throw new Error('No mobile number or email stored. Re-run `setup`.');
  }
  await fillStep(page, 'loginIdentifier', sel.loginIdentifier, identifier);

  const passwordField = await findOptional(page, 'password', sel.password, { timeout: 4000 });
  if (passwordField && vault.portalPassword) {
    await passwordField.fill(vault.portalPassword);
    log.step('filled password');
  }

  await clickStep(page, 'loginSubmit', sel.loginSubmit);

  const otpField = await findOptional(page, 'loginOtp', sel.loginOtp, { timeout: 25_000 });
  if (otpField) {
    const code = await waitForOtp(`Shopwise login for ${identifier}`);
    await otpField.fill(code);
    const submit = await findOptional(page, 'loginOtpSubmit', sel.loginOtpSubmit, {
      timeout: 5000,
    });
    // Some OTP modals submit themselves once the last digit lands.
    if (submit) await submit.click();
  } else {
    log.warn('no login OTP was asked for — the portal may have kept the session alive');
  }

  await find(page, 'loggedInMarker', sel.loggedInMarker, { timeout: 45_000 });
  log.info('logged in');
}

async function findProduct(page, sel) {
  log.step(`searching for "${config.searchTerm}"`);
  const search = await find(page, 'searchInput', sel.searchInput);
  await search.click();
  await search.fill(config.searchTerm);

  // Submit exactly once. Doing both a click and an Enter re-submits an empty
  // query on the results page, because the search box is usually still there.
  const submit = await findOptional(page, 'searchSubmit', sel.searchSubmit, { timeout: 3000 });
  if (submit) await submit.click();
  else await search.press('Enter');

  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await clickStep(page, 'productLink', sel.productLink, { timeout: 45_000 });
  await page.waitForLoadState('domcontentloaded').catch(() => {});
}

async function chooseAmount(page, sel) {
  log.step(`selecting ${config.currencySymbol}${config.amount}`);

  // Portals do this one of two ways: preset denomination tiles, or a free-text box.
  const preset = await findOptional(page, 'denomination', sel.denomination, { timeout: 6000 });
  if (preset) {
    await preset.click();
    return;
  }

  const input = await findOptional(page, 'amountInput', sel.amountInput, { timeout: 6000 });
  if (input) {
    await input.fill(String(config.amount));
    return;
  }

  throw new Error(
    `Could not select the ${config.currencySymbol}${config.amount} denomination — ` +
      'neither a preset tile nor an amount field matched. Add selectors for ' +
      '"denomination" or "amountInput" in selectors.local.json.',
  );
}

/**
 * The single most important guardrail: read the real total off the page and refuse
 * to pay anything outside the expected range. A bot that pays an unverified number
 * is a bug waiting to cost money.
 *
 * The total is NOT the face value. The portal adds a convenience fee plus GST, so
 * a ₹1,000 card is charged at about ₹1,017.70. Rather than hardcode those
 * percentages — the portal serves them from its API and can change them — this
 * accepts anything between the face value floor and a computed ceiling, and logs
 * the fee it actually inferred so a change is visible in the run log.
 */
async function verifyTotal(page, sel) {
  const totalEl = await findOptional(page, 'orderTotal', sel.orderTotal, { timeout: 10_000 });
  if (!totalEl) {
    throw new Error(
      'Could not read the order total, so the amount could not be verified. ' +
        'Refusing to pay. Add a selector for "orderTotal" in selectors.local.json.',
    );
  }

  const text = await totalEl.innerText();
  const total = parseAmount(text);
  const expect = expectedCharge(config.amount);
  log.info(`order total on page: ${JSON.stringify(text.trim())} → parsed ${total}`);
  log.info(
    `expecting ~${config.currencySymbol}${expect.total} ` +
      `(${config.currencySymbol}${expect.faceValue} + ${config.currencySymbol}${expect.fee} ` +
      `fee at ${config.feePercent}% + ${config.gstPercent}% GST), ` +
      `ceiling ${config.currencySymbol}${expect.ceiling}`,
  );

  if (total === null) {
    throw new Error(`Could not parse an amount out of ${JSON.stringify(text)}. Refusing to pay.`);
  }
  if (total > expect.ceiling) {
    throw new Error(
      `Order total ${config.currencySymbol}${total} exceeds the ceiling of ` +
        `${config.currencySymbol}${expect.ceiling}. Refusing to pay. Either the fee went up ` +
        '(raise FEE_PERCENT/GST_PERCENT) or the cart holds more than one item.',
    );
  }
  if (total < expect.floor) {
    throw new Error(
      `Order total ${config.currencySymbol}${total} is below ${config.currencySymbol}${expect.floor}, ` +
        `so the cart probably holds the wrong denomination. Expected a ` +
        `${config.currencySymbol}${expect.faceValue} card. Refusing to pay.`,
    );
  }

  const impliedFee = round2(total - expect.faceValue);
  log.info(
    `amount verified: ${config.currencySymbol}${total} ` +
      `(fee ${config.currencySymbol}${impliedFee})`,
  );
  return { total, faceValue: expect.faceValue, fee: impliedFee };
}

const round2 = (n) => Math.round(n * 100) / 100;

async function fillCard(page, sel, vault) {
  log.step(`entering card ${maskCard(vault.cardNumber)}`);

  const method = await findOptional(page, 'payWithCard', sel.payWithCard, { timeout: 10_000 });
  if (method) await method.click();

  await fillStep(page, 'cardNumber', sel.cardNumber, vault.cardNumber);

  // Expiry is either one MM/YY box or two separate fields.
  const combined = await findOptional(page, 'cardExpiry', sel.cardExpiry, { timeout: 5000 });
  if (combined) {
    await combined.fill('');
    await typeInto(combined, `${vault.cardExpMonth}${vault.cardExpYear}`);
  } else {
    const month = await find(page, 'cardExpMonth', sel.cardExpMonth);
    const year = await find(page, 'cardExpYear', sel.cardExpYear);
    await setValue(month, vault.cardExpMonth);
    await setValue(year, vault.cardExpYear);
  }

  const nameField = await findOptional(page, 'cardName', sel.cardName, { timeout: 4000 });
  if (nameField && vault.cardName) await nameField.fill(vault.cardName);

  await fillStep(page, 'cardCvv', sel.cardCvv, vault.cardCvv);
}

async function typeInto(locator, value) {
  if (typeof locator.pressSequentially === 'function') {
    await locator.pressSequentially(String(value), { delay: 60 });
  } else {
    await locator.type(String(value), { delay: 60 });
  }
}

/** Works for both <select> dropdowns and plain text inputs. */
async function setValue(locator, value) {
  const tag = await locator.evaluate((node) => node.tagName.toLowerCase());
  if (tag === 'select') {
    await locator.selectOption(String(value)).catch(async () => {
      await locator.selectOption({ label: String(value) });
    });
  } else {
    await locator.fill(String(value));
  }
}

/**
 * Runs one full purchase.
 * @param {object} opts
 * @param {object} opts.vault decrypted credentials + card
 * @param {object} opts.selectors selector map
 * @param {boolean} opts.live when false, stops immediately before the payment submit
 * @param {string} opts.runDir where screenshots and the log go
 * @param {(update: object) => Promise<void>} [opts.onProgress] phase updates, for a remote UI
 */
export async function runPurchase({ vault, selectors: sel, live, runDir, onProgress }) {
  const report = async (update) => {
    if (onProgress) await onProgress(update).catch((err) => log.warn('progress:', err.message));
  };

  const context = await launchBrowser();
  const page = context.pages()[0] || (await context.newPage());
  const shot = (name) => safeScreenshot(page, path.join(runDir, `${name}.png`));

  try {
    log.step(`opening ${config.baseUrl}`);
    await report({ phase: 'opening' });
    await page.goto(config.baseUrl, { waitUntil: 'domcontentloaded' });

    await report({ phase: 'logging-in' });
    await ensureLoggedIn(page, sel, vault);

    await report({ phase: 'finding-product' });
    await findProduct(page, sel);
    await shot('01-product');

    await chooseAmount(page, sel);
    await clickStep(page, 'addToCart', sel.addToCart);

    const cartLink = await findOptional(page, 'goToCart', sel.goToCart, { timeout: 10_000 });
    if (cartLink) await cartLink.click();
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await shot('02-cart');

    const charge = await verifyTotal(page, sel);
    await report({ phase: 'verified', ...charge });

    if (!live) {
      await shot('03-dry-run-stop');
      log.info('DRY RUN — cart is correct and the flow stopped before payment.');
      log.info('Re-run with --live to actually pay.');
      return { status: 'dry-run', ...charge };
    }

    await report({ phase: 'paying', ...charge });
    await clickStep(page, 'checkout', sel.checkout);
    await page.waitForLoadState('domcontentloaded').catch(() => {});

    await fillCard(page, sel, vault);
    await shot('03-payment');

    await clickStep(page, 'payNow', sel.payNow);

    log.step('waiting for the bank OTP page');
    const otpField = await find(page, 'paymentOtp', sel.paymentOtp, { timeout: 90_000 });
    const code = await waitForOtp(
      `${config.currencySymbol}${charge.total} Amazon Pay gift card ` +
        `on card ${maskCard(vault.cardNumber)}`,
    );
    await otpField.fill(code);
    await clickStep(page, 'paymentOtpSubmit', sel.paymentOtpSubmit);

    log.step('waiting for confirmation');
    await find(page, 'orderConfirmation', sel.orderConfirmation, { timeout: 120_000 });

    let orderId = null;
    const idEl = await findOptional(page, 'orderId', sel.orderId, { timeout: 8000 });
    if (idEl) orderId = (await idEl.innerText()).trim();

    await shot('04-confirmed');
    log.info(`purchase complete${orderId ? ` — ${orderId}` : ''}`);
    return { status: 'success', ...charge, orderId };
  } catch (err) {
    await shot('99-failure').catch(() => {});
    throw err;
  } finally {
    await context.close().catch(() => {});
  }
}
