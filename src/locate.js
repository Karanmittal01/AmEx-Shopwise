import { config } from './config.js';
import { log } from './log.js';

/**
 * Every step in the flow is described by a *list* of candidate locators rather than
 * one brittle CSS path. We poll each candidate across every frame on the page until
 * one resolves to something visible. Payment fields in Indian gateways almost always
 * live inside an iframe, so frame traversal is not optional here.
 *
 * Candidate syntax:
 *   css=#add-to-cart
 *   text=Add to cart
 *   role=button|Add to cart
 *   placeholder=Card number
 *   label=Card Number
 *   testid=add-to-cart
 */
function build(scope, spec) {
  const eq = spec.indexOf('=');
  if (eq === -1) return scope.locator(spec);
  const kind = spec.slice(0, eq).trim();
  const value = spec.slice(eq + 1).trim();

  switch (kind) {
    case 'css':
      return scope.locator(value);
    case 'text':
      return scope.getByText(new RegExp(escapeRe(value), 'i')).first();
    case 'role': {
      const [role, name] = value.split('|');
      return name
        ? scope.getByRole(role.trim(), { name: new RegExp(escapeRe(name.trim()), 'i') })
        : scope.getByRole(role.trim());
    }
    case 'placeholder':
      return scope.getByPlaceholder(new RegExp(escapeRe(value), 'i'));
    case 'label':
      return scope.getByLabel(new RegExp(escapeRe(value), 'i'));
    case 'testid':
      return scope.getByTestId(value);
    default:
      return scope.locator(spec);
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Optional last resort when every candidate for a step misses.
 *
 * Set by `buy` to the tap-to-fix picker: instead of aborting, it shows the
 * elements actually on the page on your phone, you tap the right one, and the
 * choice is saved so it never has to be asked again. `find` calls this only
 * after exhausting its candidates, so a correct guess costs nothing.
 */
let assistProvider = null;

export function setAssistProvider(fn) {
  assistProvider = fn;
}

async function firstVisible(scope, spec) {
  const locator = build(scope, spec);
  const count = await locator.count();
  for (let i = 0; i < Math.min(count, 5); i++) {
    const nth = locator.nth(i);
    if (await nth.isVisible().catch(() => false)) return nth;
  }
  return null;
}

/**
 * Resolve one of `candidates` to a visible element, searching all frames.
 * @returns {Promise<import('playwright').Locator>}
 * @throws if nothing resolves before the deadline
 */
export async function find(
  page,
  name,
  candidates,
  { timeout = config.stepTimeoutMs, assist = true } = {},
) {
  if (!candidates || candidates.length === 0) {
    throw new Error(`No selector candidates configured for step "${name}".`);
  }
  const deadline = Date.now() + timeout;
  let lastError = null;

  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      for (const spec of candidates) {
        try {
          const found = await firstVisible(frame, spec);
          if (found) {
            log.info(`  ↳ "${name}" matched ${spec}`);
            return found;
          }
        } catch (err) {
          lastError = err;
        }
      }
    }
    await page.waitForTimeout(500);
  }

  // Nothing matched. Before giving up, offer the tap-to-fix picker if one is set.
  if (assist && assistProvider) {
    const picked = await assistProvider({ page, name, candidates });
    if (picked) return picked;
  }

  throw new Error(
    `Could not find "${name}" on ${page.url()}.\n` +
      `Tried: ${candidates.join(' | ')}\n` +
      `Fix it by adding a working selector under "${name}" in selectors.local.json ` +
      `(run \`node src/index.js calibrate\` to inspect the page).` +
      (lastError ? `\nLast error: ${lastError.message}` : ''),
  );
}

/** Resolve a single selector to the first visible element across all frames, or null. */
export async function resolveSelector(page, spec) {
  for (const frame of page.frames()) {
    const found = await firstVisible(frame, spec).catch(() => null);
    if (found) return found;
  }
  return null;
}

/**
 * Like `find`, but returns null instead of throwing. For genuinely optional steps.
 *
 * Assist is off here: an optional step that misses is *meant* to be skipped, so it
 * must never pop the tap-to-fix picker — otherwise "are we already logged in?"
 * would stop and ask you to point at a logout button that isn't there.
 */
export async function findOptional(page, name, candidates, { timeout = 5000 } = {}) {
  if (!candidates || candidates.length === 0) return null;
  try {
    return await find(page, name, candidates, { timeout, assist: false });
  } catch {
    log.info(`  ↳ optional step "${name}" not present, skipping`);
    return null;
  }
}

export async function clickStep(page, name, candidates, opts) {
  const el = await find(page, name, candidates, opts);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: config.stepTimeoutMs });
  log.step(`clicked ${name}`);
}

export async function fillStep(page, name, candidates, value, opts) {
  const el = await find(page, name, candidates, opts);
  await el.scrollIntoViewIfNeeded().catch(() => {});
  await el.click({ timeout: config.stepTimeoutMs }).catch(() => {});
  await el.fill('');
  // Typing beats fill() for card fields: many gateways listen for keystrokes to
  // apply input masks and to enable the pay button.
  if (typeof el.pressSequentially === 'function') {
    await el.pressSequentially(String(value), { delay: 60 });
  } else {
    await el.type(String(value), { delay: 60 });
  }
  log.step(`filled ${name}`);
}
