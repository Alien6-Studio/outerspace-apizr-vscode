const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { once } = require('node:events');
const { UsageTelemetry, usagePayload, postReport, TELEMETRY_ENDPOINT } = require('../out/telemetry');

const event = { operation: 'inspect', outcome: 'success', count: 1 };
const report = { schema_version: 'apizr.telemetry/v1', context: 'vscode', events: [event] };
const preview = (value = report) => ({ collection_enabled: true, transmission_available: false, endpoint: 'https://untrusted.invalid/', payload: JSON.stringify(value) });

async function receiver(handler, action) {
    const sockets = new Set();
    const server = http.createServer(handler);
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const request = (url, options, callback) => {
        assert.equal(url, TELEMETRY_ENDPOINT);
        assert.equal(options.rejectUnauthorized, true);
        assert.equal(options.agent, false);
        assert.equal(options.method, 'POST');
        assert.deepEqual(Object.keys(options.headers).sort(), ['Content-Length', 'Content-Type']);
        return http.request({ ...options, hostname: '127.0.0.1', port: server.address().port, path: '/' }, callback);
    };
    try { await action(request); } finally {
        for (const socket of sockets) { socket.destroy(); }
        await new Promise(resolve => server.close(resolve));
    }
}

test('wire reports contain only approved counters and reject private or invalid fields', () => {
    assert.equal(usagePayload(preview()), JSON.stringify(report));
    assert.equal(usagePayload({ ...preview(), collection_enabled: false }), undefined);
    for (const patch of [
        { context: 'cli' }, { schema_version: 'apizr.telemetry/v2' }, { path: '/private/model.py' },
        { installation_id: 'private' }, { events: [] }, { events: [event, event] },
        { events: [{ ...event, count: 0 }] }, { events: [{ ...event, count: 1001 }] },
        { events: [{ ...event, count: 1.5 }] }, { events: [{ ...event, count: true }] },
        { events: [{ ...event, operation: 'private function' }] }, { events: [{ ...event, outcome: 'traceback' }] },
        { events: [{ ...event, source: '/private/model.py' }] },
        { events: [{ ...event, count: 600 }, { ...event, outcome: 'failed', count: 401 }] },
    ]) { assert.equal(usagePayload(preview({ ...report, ...patch })), undefined); }
    assert.equal(usagePayload({ collection_enabled: true, payload: 'x'.repeat(16385) }), undefined);
    assert.equal(usagePayload({ collection_enabled: true, payload: '{' }), undefined);
});

test('real HTTP transport receives the exact closed payload and accepts an empty 204', async () => {
    const received = [];
    await receiver((req, res) => {
        let body = '';
        req.on('data', chunk => { body += chunk; });
        req.on('end', () => {
            received.push({ method: req.method, type: req.headers['content-type'], body });
            res.writeHead(204); res.end();
        });
    }, async request => {
        const delivery = new UsageTelemetry(() => true, (payload, signal) => postReport(payload, signal, request));
        assert.equal(await delivery.submit(preview()), true);
        assert.equal(delivery.lastDelivery, 'accepted');
        delivery.dispose();
    });
    assert.deepEqual(received, [{ method: 'POST', type: 'application/json', body: JSON.stringify(report) }]);
});

test('a redirect or backend refusal is not retried and cannot affect editor results', async () => {
    for (const status of [302, 400, 429, 503]) {
        let requests = 0;
        await receiver((req, res) => {
            requests++; req.resume();
            res.writeHead(status, { Location: 'https://untrusted.invalid/' }); res.end();
        }, async request => {
            assert.equal(await postReport(JSON.stringify(report), new AbortController().signal, request), false);
        });
        assert.equal(requests, 1);
    }
    const delivery = new UsageTelemetry(() => true, async () => { throw Error('private backend details'); });
    assert.equal(await delivery.submit(preview()), false);
    assert.equal(delivery.lastDelivery, 'failed');
    delivery.dispose();
});

test('an absolute deadline bounds stalled delivery', async () => {
    await receiver(req => req.resume(), async request => {
        const started = Date.now();
        assert.equal(await postReport(JSON.stringify(report), new AbortController().signal, request, 50), false);
        assert.ok(Date.now() - started < 1500);
    });
});

test('opt-out aborts the active request, discards the bounded queue and blocks future sends', async () => {
    let allowed = true, started = 0, aborted = 0;
    const delivery = new UsageTelemetry(() => allowed, async (_, signal) => {
        started++;
        return new Promise(resolve => signal.addEventListener('abort', () => { aborted++; resolve(false); }, { once: true }));
    });
    const active = delivery.submit(preview());
    const queued = Array.from({ length: 8 }, () => delivery.submit(preview()));
    assert.equal(await delivery.submit(preview()), false);
    allowed = false; delivery.clear();
    assert.equal(await active, false);
    assert.deepEqual(await Promise.all(queued), Array(8).fill(false));
    assert.equal(await delivery.submit(preview()), false);
    assert.equal(started, 1); assert.equal(aborted, 1);
    delivery.dispose();
});

test('disposal, disabled collection and empty reports never create network requests', async () => {
    let sent = 0;
    const delivery = new UsageTelemetry(() => true, async () => { sent++; return true; });
    assert.equal(await delivery.submit({ ...preview(), collection_enabled: false }), false);
    assert.equal(await delivery.submit(preview({ ...report, events: [] })), false);
    delivery.dispose();
    assert.equal(await delivery.submit(preview()), false);
    assert.equal(sent, 0);
});
