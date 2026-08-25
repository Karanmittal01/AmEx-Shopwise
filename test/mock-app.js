import http from 'node:http';

/**
 * A stand-in for the Splitwise Killer Tools API.
 *
 * It implements the same five endpoints the real Next.js routes do, with the same
 * paths, payload shapes and guarded transitions — including clearing the OTP the
 * moment it is collected. The point is to run the worker's real polling loop
 * against something that behaves like the app, so a mismatch in the contract
 * between the two repositories shows up here rather than during a purchase.
 */
export function startMockApp({ token, job }) {
  const state = {
    job: { ...job, status: 'QUEUED' },
    progress: [],
    finished: null,
    otpRequests: [],
    otpCode: null,
    cancelled: false,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body ?? {}));
    };

    if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'nope' });

    const body = await readJson(req);
    const path = url.pathname;

    if (path === '/api/tools/shopwise/jobs/next' && req.method === 'POST') {
      if (state.job.status !== 'QUEUED') return send(200, { job: null });
      state.job.status = 'RUNNING';
      return send(200, {
        job: { id: state.job.id, mode: state.job.mode, faceValueCents: state.job.faceValueCents },
      });
    }

    const jobPath = (suffix) => `/api/tools/shopwise/jobs/${state.job.id}${suffix}`;

    if (path === jobPath('/progress') && req.method === 'POST') {
      state.progress.push(body);
      return send(200, { ok: true });
    }

    if (path === jobPath('/otp/request') && req.method === 'POST') {
      state.otpRequests.push(body.purpose);
      state.job.status = 'AWAITING_OTP';
      state.otpCode = null; // a stale code must never satisfy a fresh request
      return send(200, { ok: true });
    }

    if (path === jobPath('/otp') && req.method === 'GET') {
      if (state.cancelled) return send(200, { cancelled: true, code: null });
      const code = state.otpCode;
      if (code) {
        state.otpCode = null; // collected exactly once
        state.job.status = 'RUNNING';
      }
      return send(200, { cancelled: false, code });
    }

    if (path === jobPath('/finish') && req.method === 'POST') {
      state.finished = body;
      state.job.status = body.status.toUpperCase();
      return send(200, { ok: true });
    }

    return send(404, { error: 'no such route' });
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        state,
        /** Stands in for you typing the code into the Tools page. */
        submitOtp: (code) => {
          state.otpCode = code;
        },
        cancel: () => {
          state.cancelled = true;
        },
        close: () => new Promise((done) => server.close(done)),
      });
    });
  });
}

function readJson(req) {
  return new Promise((resolve) => {
    if (req.method !== 'POST') return resolve({});
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
      if (data.length > 100_000) req.destroy();
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
