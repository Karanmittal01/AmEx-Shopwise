import fs from 'node:fs';
import { config } from './config.js';

/**
 * Tracks how many of the six monthly purchases have gone through.
 *
 * The scheduler is deliberately dumb: cron fires often, and this file decides
 * whether a run is actually due. That is far more reliable on a phone than a
 * long-lived node process, and it makes double-firing harmless — one purchase
 * per calendar month, six in total, and that is that.
 */

const EMPTY = { runs: [], createdAt: null };

export function loadState() {
  if (!fs.existsSync(config.stateFile)) return { ...EMPTY, runs: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(config.stateFile, 'utf8'));
    return { ...EMPTY, ...parsed, runs: parsed.runs || [] };
  } catch {
    return { ...EMPTY, runs: [] };
  }
}

export function saveState(state) {
  fs.writeFileSync(config.stateFile, JSON.stringify(state, null, 2));
}

/** "2026-08" — the month bucket a run counts against. */
export const monthKey = (date = new Date()) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;

export const successfulRuns = (state) => state.runs.filter((r) => r.status === 'success');

export function isDue(state, now = new Date()) {
  const done = successfulRuns(state);
  if (done.length >= config.totalRuns) {
    return { due: false, reason: `all ${config.totalRuns} purchases are already done` };
  }
  if (done.some((r) => r.month === monthKey(now))) {
    return { due: false, reason: `already purchased in ${monthKey(now)}` };
  }
  return { due: true, reason: `purchase ${done.length + 1} of ${config.totalRuns}` };
}

export function recordRun(entry) {
  const state = loadState();
  if (!state.createdAt) state.createdAt = new Date().toISOString();
  state.runs.push({
    month: monthKey(),
    at: new Date().toISOString(),
    ...entry,
  });
  saveState(state);
  return state;
}
