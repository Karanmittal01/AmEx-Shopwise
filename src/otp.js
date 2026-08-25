import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { config } from './config.js';
import { log, registerSecret } from './log.js';
import { ask } from './prompt.js';

/**
 * The only manual step in the whole flow: you send the OTP.
 *
 * Three ways to send it, whichever is handy — first one to arrive wins:
 *   1. Open http://<host>:8787/ on your phone and type it into the box.
 *   2. POST/GET it:  curl "http://localhost:8787/otp?code=123456"
 *   3. Drop it in a file:  echo 123456 > otp.txt
 *   4. Type it at the terminal, if the script is running in one.
 *
 * Deliberately human-in-the-loop: the script never reads your SMS inbox. You see
 * what you are approving and you can abort by simply not sending a code.
 */

const PAGE = (purpose) => `<!doctype html>
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shopwise OTP</title>
<style>
  body{font:16px/1.5 system-ui,sans-serif;margin:0;display:grid;place-items:center;
       min-height:100vh;background:#0f172a;color:#e2e8f0;padding:1.5rem}
  form{width:100%;max-width:22rem;text-align:center}
  h1{font-size:1.1rem;font-weight:600;margin:0 0 .25rem}
  p{color:#94a3b8;font-size:.9rem;margin:0 0 1.25rem}
  input{width:100%;font-size:2rem;letter-spacing:.4em;text-align:center;padding:.75rem;
        border-radius:.75rem;border:1px solid #334155;background:#1e293b;color:#e2e8f0;
        box-sizing:border-box}
  button{width:100%;margin-top:1rem;padding:.9rem;font-size:1rem;font-weight:600;
         border:0;border-radius:.75rem;background:#2563eb;color:#fff}
</style>
<form method="POST" action="/otp">
  <h1>Enter OTP</h1>
  <p>${purpose}</p>
  <input name="code" inputmode="numeric" autocomplete="one-time-code"
         pattern="[0-9]*" autofocus required>
  <button type="submit">Send</button>
</form>`;

const DONE = `<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
<style>body{font:16px system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;
margin:0;background:#0f172a;color:#e2e8f0}</style><p>Got it — you can close this.</p>`;

function localAddresses() {
  const out = [];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(entry.address);
    }
  }
  return out;
}

function notify(purpose) {
  // Best effort. Termux users get a real notification; everyone else gets a bell.
  execFile('termux-notification', ['--title', 'Shopwise OTP needed', '--content', purpose], (err) => {
    if (err) process.stdout.write('\x07');
  });
}

const looksLikeOtp = (code) => /^\d{4,8}$/.test(String(code).trim());

/**
 * Blocks until an OTP arrives or the timeout expires.
 * @param {string} purpose shown to you so you know which OTP is being asked for
 * @returns {Promise<string>}
 */
export function waitForOtp(purpose = 'Shopwise payment') {
  return new Promise((resolve, reject) => {
    let settled = false;
    const cleanups = [];

    const finish = (err, code) => {
      if (settled) return;
      settled = true;
      for (const fn of cleanups) {
        try {
          fn();
        } catch {
          /* best effort */
        }
      }
      if (err) reject(err);
      else {
        registerSecret(code);
        resolve(code);
      }
    };

    // --- 1. HTTP endpoint ----------------------------------------------------
    const server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      const accept = (code) => {
        if (!looksLikeOtp(code)) {
          res.writeHead(400, { 'content-type': 'text/html' });
          res.end(PAGE(`${purpose} — that did not look like an OTP, try again.`));
          return false;
        }
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end(DONE);
        return true;
      };

      if (req.method === 'GET' && url.pathname === '/otp' && url.searchParams.get('code')) {
        const code = url.searchParams.get('code').trim();
        if (accept(code)) finish(null, code);
        return;
      }

      if (req.method === 'POST' && url.pathname === '/otp') {
        let body = '';
        req.on('data', (chunk) => {
          body += chunk;
          if (body.length > 1024) req.destroy();
        });
        req.on('end', () => {
          const code = (new URLSearchParams(body).get('code') || body).trim();
          if (accept(code)) finish(null, code);
        });
        return;
      }

      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PAGE(purpose));
    });

    server.on('error', (err) => log.warn('OTP web server unavailable:', err.message));
    server.listen(config.otpPort, () => {
      const hosts = ['localhost', ...localAddresses()];
      log.info(
        `OTP needed (${purpose}). Open ${hosts
          .map((h) => `http://${h}:${config.otpPort}/`)
          .join('  or  ')}`,
      );
      log.info(`…or run: echo <code> > ${config.otpFile}`);
      notify(purpose);
    });
    cleanups.push(() => server.close());

    // --- 2. File drop --------------------------------------------------------
    try {
      fs.rmSync(config.otpFile, { force: true });
    } catch {
      /* ignore */
    }
    const poll = setInterval(() => {
      if (!fs.existsSync(config.otpFile)) return;
      const code = fs.readFileSync(config.otpFile, 'utf8').trim();
      fs.rmSync(config.otpFile, { force: true });
      if (looksLikeOtp(code)) finish(null, code);
      else log.warn('otp.txt did not contain a 4-8 digit code — ignored.');
    }, 1000);
    cleanups.push(() => clearInterval(poll));

    // --- 3. Terminal ---------------------------------------------------------
    if (process.stdin.isTTY) {
      ask('OTP: ')
        .then((code) => {
          if (looksLikeOtp(code)) finish(null, code);
        })
        .catch(() => {
          /* another channel will answer */
        });
    }

    // --- Timeout -------------------------------------------------------------
    const timer = setTimeout(
      () => finish(new Error(`No OTP received within ${Math.round(config.otpTimeoutMs / 1000)}s`)),
      config.otpTimeoutMs,
    );
    cleanups.push(() => clearTimeout(timer));
  });
}
