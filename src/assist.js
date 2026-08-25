import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { log } from './log.js';
import { resolveSelector } from './locate.js';

/**
 * Tap-to-fix.
 *
 * The selectors shipped with this project are guesses, so a step will sometimes
 * fail to find its button. Rather than make you edit a JSON file in a phone
 * terminal, this enumerates the elements actually on the page, hands them to the
 * control page as a tappable list, and — once you pick — writes the choice into
 * selectors.local.json so the step is fixed for good.
 *
 * Card and CVV fields are deliberately kept out of the list: those are filled,
 * never picked, and showing them invites tapping the wrong thing.
 */

const OVERRIDES = process.env.SELECTORS_LOCAL_FILE || path.join(ROOT, 'selectors.local.json');

/**
 * A build()-compatible selector for one element, chosen for stability: an id or
 * name outlives a redeploy, a minified class name does not. Computed in the
 * browser, where the DOM is.
 */
const ENUMERATE = `(() => {
  const pick = 'a,button,input,select,textarea,[role=button],[role=link],[role=radio],[onclick]';
  const out = [];
  const seen = new Set();

  const cssEscape = (s) => (window.CSS && CSS.escape ? CSS.escape(s) : String(s).replace(/[^a-zA-Z0-9_-]/g, '\\\\$&'));

  const selectorFor = (el) => {
    if (el.id) return 'css=#' + cssEscape(el.id);
    const testid = el.getAttribute('data-testid');
    if (testid) return 'testid=' + testid;
    const name = el.getAttribute('name');
    if (name) return "css=" + el.tagName.toLowerCase() + '[name="' + name + '"]';
    const ph = el.getAttribute('placeholder');
    if (ph) return 'placeholder=' + ph;
    const aria = el.getAttribute('aria-label');
    if (aria) return 'role=' + (el.getAttribute('role') || 'button') + '|' + aria;
    const text = (el.innerText || el.value || '').trim().slice(0, 40);
    if (text) return 'text=' + text;
    return null;
  };

  const labelFor = (el) => {
    const tag = el.tagName.toLowerCase();
    const kind = tag === 'input' ? (el.getAttribute('type') || 'text')
      : tag === 'select' ? 'dropdown'
      : tag === 'a' ? 'link'
      : 'button';
    const text = (el.innerText || el.value || el.getAttribute('placeholder')
      || el.getAttribute('aria-label') || el.getAttribute('name') || '').trim().slice(0, 50);
    return (kind + ': ' + (text || '(no label)')).trim();
  };

  for (const el of document.querySelectorAll(pick)) {
    const rect = el.getBoundingClientRect();
    if (rect.width < 4 || rect.height < 4) continue; // hidden or collapsed

    const type = (el.getAttribute('type') || '').toLowerCase();
    const name = (el.getAttribute('name') || '').toLowerCase();
    const id = (el.id || '').toLowerCase();
    // Never offer a card/CVV field as a tap target.
    if (type === 'password' || /card|cvv|cvc|number/.test(name + id)) continue;

    const selector = selectorFor(el);
    if (!selector || seen.has(selector)) continue;
    seen.add(selector);
    out.push({ label: labelFor(el), selector });
    if (out.length >= 40) break;
  }
  return out;
})()`;

/** Every tappable element on the page, across frames, with a stable selector each. */
export async function enumerateChoices(page) {
  const choices = [];
  const seen = new Set();
  for (const frame of page.frames()) {
    const items = await frame.evaluate(ENUMERATE).catch(() => []);
    for (const item of items) {
      if (seen.has(item.selector)) continue;
      seen.add(item.selector);
      choices.push(item);
    }
  }
  return choices;
}

/** Merge one step's selector into selectors.local.json, keeping any existing ones. */
export function saveSelectorOverride(name, selector) {
  let current = {};
  if (fs.existsSync(OVERRIDES)) {
    try {
      current = JSON.parse(fs.readFileSync(OVERRIDES, 'utf8'));
    } catch {
      log.warn('selectors.local.json was not valid JSON — starting a fresh one.');
    }
  }
  // Put the picked selector first, but keep the shipped guesses as fallbacks in
  // case the page changes slightly next month.
  const existing = Array.isArray(current[name]) ? current[name].filter((s) => s !== selector) : [];
  current[name] = [selector, ...existing];
  fs.writeFileSync(OVERRIDES, JSON.stringify(current, null, 2));
  log.info(`saved: ${name} → ${selector}`);
}

/**
 * Build the assist provider that `find` calls when it is stuck.
 *
 * @param {object} control the control server, for asking the phone to pick
 * @returns {(ctx: {page: import('playwright').Page, name: string}) => Promise<import('playwright').Locator|null>}
 */
export function makeAssistProvider(control) {
  return async ({ page, name }) => {
    const choices = await enumerateChoices(page);
    if (choices.length === 0) {
      log.warn(`nothing tappable found on the page to fix "${name}"`);
      return null;
    }

    log.info(`asking you to pick the element for "${name}" (${choices.length} options)`);
    const index = await control.requestPick(name, choices.map((c) => c.label));
    if (index === null || index < 0 || index >= choices.length) return null;

    const chosen = choices[index];
    const element = await resolveSelector(page, chosen.selector);
    if (!element) {
      log.warn(`the picked element (${chosen.selector}) could not be resolved — try again`);
      return null;
    }

    saveSelectorOverride(name, chosen.selector);
    return element;
  };
}
