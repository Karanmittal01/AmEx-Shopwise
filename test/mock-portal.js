import http from 'node:http';

/**
 * A stand-in for the real portal, used by the end-to-end test. It mimics the shape
 * of a typical Indian gift-card checkout — cookie session, search, denomination
 * tiles, a cart total, card fields inside a payment-gateway iframe, and a bank OTP
 * step — so the flow can be exercised without spending money or hammering the
 * real site.
 */

const CARD = { number: '4111111111111111', cvv: '4821', exp: '1230' };
const OTP = '654321';
const MOBILE = '9876500000';

/** Same arithmetic the real portal does: 1.5% convenience fee, then 18% GST on it. */
const FEE_PERCENT = 1.5;
const GST_PERCENT = 18;
const feeFor = (amount) => (amount * FEE_PERCENT) / 100 * (1 + GST_PERCENT / 100);
const money = (n) => n.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const html = (body) =>
  `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width">${body}`;

export function startMockPortal(port = 0) {
  const sessions = new Set();
  const state = {
    cart: null,
    chargedTotal: null,
    payment: null,
    orderId: null,
    amountTampered: false,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cookie = req.headers.cookie || '';
    const sessionId = /sid=([^;]+)/.exec(cookie)?.[1];
    const loggedIn = sessionId && sessions.has(sessionId);

    const body = await readBody(req);
    const form = new URLSearchParams(body);
    const send = (markup, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(html(markup));
    };
    const redirect = (to, headers = {}) => {
      res.writeHead(302, { location: to, ...headers });
      res.end();
    };

    const nav = loggedIn
      ? `<a href="/logout">Logout</a>
         <form action="/search"><input type="search" name="q" placeholder="Search" aria-label="Search"><button type="submit">Search</button></form>`
      : `<a href="/login">Login</a>`;

    switch (url.pathname) {
      case '/':
        return send(`<h1>Shopwise</h1>${nav}`);

      // Sign-in is by mobile number (or email) and an OTP — no password at all,
      // which is what the real portal does.
      case '/login':
        if (req.method === 'POST') {
          const identifier = (form.get('mobile_email') || '').replace(/\D/g, '');
          if (identifier === MOBILE) {
            return send(`<h1>Verify</h1>
              <div class="otp_modal">
                <form method="POST" action="/login-otp">
                  <label>OTP <input name="otpname" autocomplete="one-time-code"></label>
                  <button type="submit">Verify</button>
                </form>
              </div>`);
          }
          return send(`<p>Unknown mobile number</p>`, 401);
        }
        return send(`<h1>Login</h1>
          <form method="POST" action="/login">
            <label>Mobile Number or Email <input name="mobile_email" type="tel"></label>
            <button type="submit">Continue</button>
          </form>`);

      case '/login-otp': {
        if (form.get('otpname') !== OTP) return send('<p>Wrong OTP</p>', 401);
        const sid = `s${Date.now()}`;
        sessions.add(sid);
        return redirect('/', { 'set-cookie': `sid=${sid}; Path=/` });
      }

      case '/logout':
        sessions.delete(sessionId);
        return redirect('/');

      case '/search': {
        if (!loggedIn) return redirect('/login');
        const q = (url.searchParams.get('q') || '').toLowerCase();
        const hit = q.includes('amazon');
        return send(`${nav}<h1>Results for ${q}</h1>
          ${hit ? `<a href="/product">Amazon Pay Gift Card</a>` : '<p>No results</p>'}
          <a href="/product-other">Flipkart Gift Card</a>`);
      }

      case '/product':
        if (!loggedIn) return redirect('/login');
        return send(`${nav}<h1>Amazon Pay Gift Card</h1>
          <form method="POST" action="/cart">
            <label><input type="radio" name="denomination" value="500">₹500</label>
            <label><input type="radio" name="denomination" value="1000">₹1,000</label>
            <label><input type="radio" name="denomination" value="2000">₹2,000</label>
            <button type="submit">Add to cart</button>
          </form>`);

      case '/cart': {
        if (!loggedIn) return redirect('/login');
        if (req.method === 'POST') {
          state.cart = Number(form.get('denomination'));
          return redirect('/cart');
        }
        // The test can force a mismatch here to prove the guardrail bites.
        const face = state.amountTampered ? state.cart + 500 : state.cart;
        const fee = feeFor(face);
        state.chargedTotal = Math.round((face + fee) * 100) / 100;
        return send(`${nav}<h1>Cart</h1>
          <p>Amazon Pay Gift Card</p>
          <div class="order-total">
            <div>Sub total ₹${money(face)}</div>
            <div>Convenience fee (${FEE_PERCENT}%) + GST ₹${money(fee)}</div>
            <div>Total Amount ₹${money(face + fee)}</div>
          </div>
          <form action="/checkout"><button type="submit">Proceed to checkout</button></form>`);
      }

      case '/checkout':
        if (!loggedIn) return redirect('/login');
        // Card fields live in an iframe, exactly like a real payment gateway.
        return send(`${nav}<h1>Payment</h1>
          <button data-payment-method="card">Credit / Debit Card</button>
          <iframe src="/gateway" style="width:420px;height:420px;border:0"></iframe>`);

      case '/gateway':
        return send(`<form method="POST" action="/pay" target="_top">
            <label>Card number <input name="cardnumber" inputmode="numeric"></label>
            <label>Expiry <input name="expiry" placeholder="MM / YY"></label>
            <label>CVV <input name="cvv" type="password"></label>
            <label>Name on card <input name="cardholder"></label>
            <button type="submit">Pay now</button>
          </form>`);

      case '/pay': {
        const number = (form.get('cardnumber') || '').replace(/\D/g, '');
        const expiry = (form.get('expiry') || '').replace(/\D/g, '');
        const cvv = form.get('cvv') || '';
        state.payment = { number, expiry, cvv, name: form.get('cardholder') };
        if (number !== CARD.number || cvv !== CARD.cvv || expiry !== CARD.exp) {
          return send(`<p>Card declined</p>`, 402);
        }
        return send(`<h1>Bank verification</h1>
          <form method="POST" action="/confirm">
            <label>OTP <input name="otp" autocomplete="one-time-code"></label>
            <button type="submit">Submit</button>
          </form>`);
      }

      case '/confirm':
        if (form.get('otp') !== OTP) return send('<p>Wrong OTP</p>', 401);
        state.orderId = `SW${Date.now().toString().slice(-8)}`;
        return send(`<h1>Payment successful</h1>
          <p class="order-id">Order ID ${state.orderId}</p>`);

      default:
        return send('<p>Not found</p>', 404);
    }
  });

  return new Promise((resolve) => {
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        state,
        otp: OTP,
        card: CARD,
        mobile: MOBILE,
        feeFor,
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') return resolve('');
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 10_000) req.destroy();
    });
    req.on('end', () => resolve(data));
  });
}
