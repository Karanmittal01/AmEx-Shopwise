import http from 'node:http';
import os from 'node:os';
import { log, registerSecret } from './log.js';

/**
 * The whole user interface: one page, served by the same process that drives the
 * browser, for as long as that process runs.
 *
 * No database, no queue, no tokens, no second service. You start the command,
 * open the URL on your phone, tap Buy, and type the two OTPs as they arrive.
 * Everything below is one HTTP server and a bit of state held in memory.
 */

const PHASES = {
  opening: 'Opening the portal',
  'logging-in': 'Signing in',
  'finding-product': 'Finding the gift card',
  verified: 'Cart checked',
  paying: 'Entering card details',
};

export function startControlServer({ port = 8787, amount, currency = '₹' } = {}) {
  const state = {
    stage: 'idle', // idle → running → done | failed
    phase: null,
    mode: null,
    message: 'Ready',
    total: null,
    fee: null,
    orderId: null,
    error: null,
    otp: { pending: false, purpose: null },
    pick: { pending: false, name: null, choices: [] },
  };

  let startResolve = null;
  let otpResolve = null;
  let pickResolve = null;

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/state') {
      return json(res, state);
    }

    if (url.pathname === '/start' && req.method === 'POST') {
      const mode = (await body(req)).mode === 'live' ? 'live' : 'dry';
      if (startResolve) {
        state.stage = 'running';
        state.mode = mode;
        state.message = 'Starting…';
        startResolve(mode);
        startResolve = null;
      }
      return json(res, { ok: true });
    }

    if (url.pathname === '/otp' && req.method === 'POST') {
      const code = String((await body(req)).code ?? '').trim();
      if (!/^\d{4,8}$/.test(code)) return json(res, { error: 'OTPs are 4 to 8 digits.' }, 400);
      if (otpResolve) {
        state.otp = { pending: false, purpose: null };
        state.message = 'Code sent, carrying on…';
        registerSecret(code);
        otpResolve(code);
        otpResolve = null;
      }
      return json(res, { ok: true });
    }

    if (url.pathname === '/pick' && req.method === 'POST') {
      const index = Number((await body(req)).index);
      if (pickResolve && Number.isInteger(index)) {
        state.pick = { pending: false, name: null, choices: [] };
        state.message = 'Got it, carrying on…';
        pickResolve(index);
        pickResolve = null;
      }
      return json(res, { ok: true });
    }

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(page({ amount, currency }));
  });

  // Fail loudly rather than handing back a control object with no page behind it:
  // a silent failure here looks like the command hanging for no reason.
  const listening = new Promise((resolve, reject) => {
    server.once('error', (err) => {
      reject(
        new Error(
          err.code === 'EADDRINUSE'
            ? `Port ${port} is already in use — close the other copy, or set OTP_PORT to something else.`
            : `Could not start the control page: ${err.message}`,
        ),
      );
    });
    server.listen(port, resolve);
  });

  return listening.then(() => ({
    // port 0 asks the OS for a free port; report the one actually bound.
    port: server.address().port,
    urls: addresses(server.address().port),

    /** Blocks until Buy or Test run is tapped, and resolves to which. */
    waitForStart: () => new Promise((resolve) => {
      startResolve = resolve;
    }),

    /** Drop-in OTP provider for the purchase flow. */
    requestOtp: (purpose) =>
      new Promise((resolve) => {
        state.otp = { pending: true, purpose };
        state.message = 'Waiting for your OTP';
        otpResolve = resolve;
        log.info(`OTP needed: ${purpose}`);
      }),

    /**
     * Ask the phone to pick the right element for a step the flow could not find.
     * @returns {Promise<number>} the chosen index
     */
    requestPick: (name, labels) =>
      new Promise((resolve) => {
        state.pick = { pending: true, name, choices: labels };
        state.message = `Help needed: pick the "${name}" button`;
        pickResolve = resolve;
        log.info(`waiting for you to pick "${name}" on the page`);
      }),

    setPhase(update) {
      state.phase = update.phase;
      state.message = PHASES[update.phase] ?? update.phase;
      if (update.total !== undefined) state.total = update.total;
      if (update.fee !== undefined) state.fee = update.fee;
    },

    finish(result) {
      state.stage = result.error ? 'failed' : 'done';
      state.phase = null;
      state.otp = { pending: false, purpose: null };
      state.pick = { pending: false, name: null, choices: [] };
      state.total = result.total ?? state.total;
      state.orderId = result.orderId ?? null;
      state.error = result.error ?? null;
      state.message = result.error
        ? 'Failed'
        : result.status === 'dry-run'
          ? 'Test run finished — nothing was paid'
          : 'Bought';
    },

    close: () => new Promise((done) => server.close(done)),
  }));
}

function json(res, value, status = 200) {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
}

function body(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 4096) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

/** Every address the phone might reach this machine on. */
function addresses(port) {
  const out = [`http://localhost:${port}/`];
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === 'IPv4' && !entry.internal) out.push(`http://${entry.address}:${port}/`);
    }
  }
  return out;
}

const page = ({ amount, currency }) => `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gift card</title>
<style>
  :root { color-scheme: dark }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; background: #0f172a; color: #e2e8f0;
         display: grid; place-items: center; min-height: 100dvh; padding: 1.5rem }
  main { width: 100%; max-width: 24rem }
  h1 { font-size: 1.25rem; margin: 0 0 .25rem }
  .sub { color: #94a3b8; font-size: .9rem; margin: 0 0 1.5rem }
  .card { background: #1e293b; border-radius: 1rem; padding: 1.25rem; margin-bottom: 1rem }
  button { width: 100%; padding: 1rem; font-size: 1rem; font-weight: 600; border: 0;
           border-radius: .75rem; background: #2563eb; color: #fff; margin-bottom: .5rem }
  button.ghost { background: #334155 }
  button:disabled { opacity: .5 }
  input { width: 100%; box-sizing: border-box; font-size: 2rem; letter-spacing: .4em;
          text-align: center; padding: .75rem; border-radius: .75rem; border: 1px solid #475569;
          background: #0f172a; color: #e2e8f0; margin-bottom: .75rem }
  .row { display: flex; justify-content: space-between; font-size: .9rem; padding: .15rem 0 }
  .row b { font-weight: 600 }
  .muted { color: #94a3b8 }
  .spin { display: inline-block; width: .5rem; height: .5rem; border-radius: 50%;
          background: #38bdf8; margin-right: .5rem; animation: p 1s infinite }
  @keyframes p { 50% { opacity: .3 } }
  .ok { color: #4ade80 } .bad { color: #f87171 }
</style>
<main>
  <h1>Amazon Pay gift card</h1>
  <p class="sub">Amex Shopwise</p>
  <div class="card" id="body">Loading…</div>
</main>
<script>
const AMOUNT = ${JSON.stringify(`${currency}${amount}`)};
const el = document.getElementById('body');
let sending = false;

async function post(path, data) {
  sending = true;
  try {
    const r = await fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data),
    });
    if (!r.ok) alert((await r.json()).error || 'Something went wrong.');
  } finally { sending = false; tick(); }
}

function money(n) {
  return n == null ? '—' : ${JSON.stringify(currency)} + n.toLocaleString('en-IN',
    { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function render(s) {
  if (s.pick.pending) {
    el.innerHTML =
      '<p style="margin:0 0 .25rem"><b>Which one is it?</b></p>' +
      '<p class="sub" style="margin:0 0 1rem">Couldn\\'t find the <b>' + esc(s.pick.name) +
        '</b> button. Tap it in the list below.</p>' +
      '<div id="choices">' +
      s.pick.choices.map((label, i) =>
        '<button class="ghost pick" data-i="' + i + '" style="text-align:left">' +
          esc(label) + '</button>').join('') +
      '</div>';
    for (const b of document.querySelectorAll('.pick')) {
      b.onclick = () => post('/pick', { index: Number(b.dataset.i) });
    }
    return;
  }

  if (s.otp.pending) {
    el.innerHTML =
      '<p style="margin:0 0 .75rem"><b>Enter the OTP</b></p>' +
      '<p class="sub" style="margin:0 0 1rem">' + esc(s.otp.purpose || '') + '</p>' +
      '<input id="code" inputmode="numeric" autocomplete="one-time-code" placeholder="······" autofocus>' +
      '<button id="send">Send code</button>';
    const code = document.getElementById('code');
    document.getElementById('send').onclick = () => {
      if (/^\\d{4,8}$/.test(code.value.trim())) post('/otp', { code: code.value.trim() });
    };
    code.onkeydown = (e) => { if (e.key === 'Enter') document.getElementById('send').click(); };
    code.focus();
    return;
  }

  if (s.stage === 'idle') {
    el.innerHTML =
      '<button id="live">Buy ' + AMOUNT + ' gift card</button>' +
      '<button id="dry" class="ghost">Test run — stops before paying</button>';
    document.getElementById('live').onclick = () => post('/start', { mode: 'live' });
    document.getElementById('dry').onclick = () => post('/start', { mode: 'dry' });
    return;
  }

  if (s.stage === 'running') {
    el.innerHTML =
      '<p style="margin:0 0 .75rem"><span class="spin"></span>' + esc(s.message) + '</p>' +
      (s.total != null
        ? '<div class="row"><span class="muted">Charged</span><b>' + money(s.total) + '</b></div>'
        : '') +
      '<p class="sub" style="margin:.75rem 0 0">Keep this page open.</p>';
    return;
  }

  el.innerHTML =
    '<p class="' + (s.stage === 'done' ? 'ok' : 'bad') + '" style="margin:0 0 .75rem"><b>' +
      esc(s.message) + '</b></p>' +
    (s.total != null
      ? '<div class="row"><span class="muted">Charged</span><b>' + money(s.total) + '</b></div>'
      : '') +
    (s.orderId ? '<div class="row"><span class="muted">Order</span><b>' + esc(s.orderId) + '</b></div>' : '') +
    (s.error ? '<p class="sub bad" style="margin:.75rem 0 0">' + esc(s.error) + '</p>' : '');
}

function esc(t) {
  return String(t).replace(/[&<>"]/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[c]));
}

let renderedPick = '';

async function tick() {
  if (sending) return;
  try {
    const s = await (await fetch('/state', { cache: 'no-store' })).json();
    // Don't repaint the OTP box under the user's fingers while they type.
    if (s.otp.pending && document.getElementById('code')?.value) return;
    // Don't rebuild an unchanged pick list under a tapping finger every poll.
    const pickKey = s.pick.pending ? s.pick.name + ':' + s.pick.choices.length : '';
    if (pickKey && pickKey === renderedPick) return;
    renderedPick = pickKey;
    render(s);
  } catch {}
}

tick();
setInterval(tick, 1500);
</script>`;
