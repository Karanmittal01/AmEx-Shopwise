import fs from 'node:fs';
import path from 'node:path';

/**
 * Values registered here are scrubbed from every log line and error message.
 * Card numbers, CVVs, passwords and OTPs get registered as soon as they are read,
 * so an unexpected stack trace can never leak them into a log file.
 */
const secrets = new Set();

export function registerSecret(value) {
  if (typeof value === 'string' && value.length >= 3) secrets.add(value);
}

export function redact(text) {
  let out = String(text);
  for (const s of secrets) {
    out = out.split(s).join('[redacted]');
  }
  // Catch anything card-shaped that was never registered (e.g. read back off the page).
  out = out.replace(/\b(?:\d[ -]*?){13,19}\b/g, (m) => {
    const digits = m.replace(/\D/g, '');
    if (digits.length < 13 || digits.length > 19) return m;
    return `****${digits.slice(-4)}`;
  });
  return out;
}

export function maskCard(number) {
  const digits = String(number).replace(/\D/g, '');
  return digits.length >= 4 ? `**** **** **** ${digits.slice(-4)}` : '****';
}

let logStream = null;

export function openRunLog(runDir) {
  fs.mkdirSync(runDir, { recursive: true });
  logStream = fs.createWriteStream(path.join(runDir, 'run.log'), { flags: 'a' });
}

export function closeRunLog() {
  if (logStream) logStream.end();
  logStream = null;
}

function write(level, args) {
  const line = `${new Date().toISOString()} [${level}] ${redact(args.map(fmt).join(' '))}`;
  if (level === 'ERROR') console.error(line);
  else console.log(line);
  if (logStream) logStream.write(`${line}\n`);
}

function fmt(a) {
  if (a instanceof Error) return a.stack || a.message;
  if (typeof a === 'object' && a !== null) return JSON.stringify(a);
  return String(a);
}

export const log = {
  info: (...a) => write('INFO', a),
  step: (...a) => write('STEP', a),
  warn: (...a) => write('WARN', a),
  error: (...a) => write('ERROR', a),
};
