import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test, type TestContext } from 'node:test';
import { once } from 'node:events';
import express, { type Express } from 'express';
import { createApp } from './app.js';
import { createSiteApi } from './site-api.js';

async function listen(t: TestContext, app: Express) {
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => { const closed = once(server, 'close'); server.close(); server.closeAllConnections(); await closed; });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return address.port;
}

async function start(t: TestContext, mock = createApp(), timeout?: number) {
  const mockPort = await listen(t, mock);
  const port = await listen(t, createSiteApi({ mode: 'mock', apiPort: 0, mockPort }, timeout));
  return (path: string, body?: object, headers?: Record<string, string>) => fetch(`http://127.0.0.1:${port}${path}`, body && {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body),
  });
}

test('已移除的接口返回 404，卡密可重复预览', async t => {
  const api = await start(t);
  assert.equal((await api('/api')).status, 404);
  assert.equal((await api('/api/v2/site')).status, 404);
  assert.equal((await api('/api/v2/sites/yuanxuai/preview', { redeem_code: 'YUANXUAI-DEMO' })).status, 404);
  assert.equal((await api('/api/preview', { redeem_code: 'INVALID' })).status, 400);
  for (let i = 0; i < 2; i++) {
    assert.deepEqual(await (await api('/api/preview', { redeem_code: ' YUANXUAI-DEMO ' })).json(),
      { plan: 'plus', plan_label: 'Plus', region: 'PH', expires_at: null });
  }
});

const session = JSON.stringify({ user: { email: 'demo@example.test' }, accessToken: 'mock-session-local-only' });

test('预览不建单、提交去重且按卡密查询', async t => {
  const api = await start(t);
  const body = { redeem_code: 'YUANXUAI-DEMO' };
  for (let i = 0; i < 2; i++) await api('/api/preview', body);
  assert.equal((await (await api('/api/lookup', body)).json()).job, null);
  const submit = { ...body, chatgpt_token: session, request_id: randomUUID(), turnstile_token: null };
  const initial = await api('/api/submit', submit);
  const first = await initial.json();
  assert.equal(first.status, 'pending');
  assert.equal((await (await api('/api/submit', submit)).json()).job_id, first.job_id);
  assert.equal((await (await api('/api/lookup', { redeem_code: 'YUANXUAI-FAIL' })).json()).job, null);
  assert.equal((await (await api('/api/lookup', body)).json()).job.status, 'processing');
  assert.equal((await (await api('/api/lookup', body)).json()).job.status, 'succeeded');
  const second = await (await api('/api/submit', { ...submit, request_id: randomUUID() })).json();
  assert.notEqual(second.job_id, first.job_id);
  assert.equal((await (await api('/api/lookup', body)).json()).job.job_id, second.job_id);
});

test('模拟失败、取消、待核验和持续处理', async t => {
  const api = await start(t);
  for (const [suffix, status] of Object.entries({ FAIL: 'failed', CANCEL: 'cancelled', MANUAL: 'manual_review', PENDING: 'pending' })) {
    const body = { redeem_code: `YUANXUAI-${suffix}` };
    assert.equal((await api('/api/submit', { ...body, chatgpt_token: session, request_id: randomUUID(), turnstile_token: null })).status, 200);
    for (let i = 0; i < 2; i++) assert.equal((await (await api('/api/lookup', body)).json()).job.status, status);
  }
});

test('拒绝非模拟 Session，且不回显请求内容', async t => {
  const api = await start(t);
  const marker = 'PRIVATE-TEST-MARKER';
  const response = await api('/api/submit', { redeem_code: 'YUANXUAI-DEMO', request_id: randomUUID(), turnstile_token: null, chatgpt_token: JSON.stringify({ user: { email: 'demo@example.test' }, accessToken: marker }) });
  assert.equal(response.status, 400);
  assert.doesNotMatch(await response.text(), new RegExp(marker));
});

test('只向三个固定的 mocker 路由发送协议字段，不转发客户端头或真实凭据', async t => {
  const mock = express().use(express.json());
  const calls: unknown[] = [];
  const raw = { job_id: 'private-order', status: 'pending', plan: 'plus', plan_label: 'private-label', account_email: 'private@example.test', created_at: '2026-01-01T00:00:00Z', token: 'private-token' };
  mock.post('/api/v2/sites/yuanxuai/:operation', (req, res) => {
    calls.push([req.method, req.path, req.body, req.get('X-API-Key'), req.get('Authorization')]);
    res.set('X-Private', 'secret').json(req.params.operation === 'lookup' ? { job: raw, message: 'private-message' } :
      req.params.operation === 'preview' ? { ...raw, region: 'PH', expires_at: null } : raw);
  });
  const api = await start(t, mock);
  const body = { redeem_code: 'YUANXUAI-DEMO' };
  const submit = { ...body, chatgpt_token: session, request_id: randomUUID(), turnstile_token: null };
  const headers = { 'X-API-Key': 'must-not-forward', Authorization: 'must-not-forward' };
  assert.equal((await api('/api/submit', { ...submit, request_id: 'wrong' })).status, 400);
  assert.equal((await api('/api/submit', { ...submit, turnstile_token: {} })).status, 400);
  assert.equal((await api('/api/submit', { ...submit, chatgpt_token: '{}' })).status, 400);
  const preview = await api('/api/preview', { ...body, redeem_code: ` ${body.redeem_code} `, ignored: true }, headers);
  assert.deepEqual(await preview.json(), { plan: 'plus', plan_label: 'Plus', region: 'PH', expires_at: null });
  assert.equal(preview.headers.get('X-Private'), null);
  const started = await api('/api/submit', { ...submit, ignored: true }, headers);
  const job = await started.json();
  assert.deepEqual(job, { job_id: job.job_id, status: 'pending', plan: 'plus', plan_label: 'Plus', created_at: '2026-01-01T00:00:00.000Z', account_email: raw.account_email });
  assert.match(job.job_id, /^[a-f0-9]{32}$/);
  const found = await api('/api/lookup', { ...body, job_id: 'ignored' }, headers);
  assert.deepEqual(await found.json(), { job, message: '已查询到最近一次充值订单。' });
  assert.deepEqual(calls, [['preview', body], ['submit', submit], ['lookup', body]].map(([name, payload]) =>
    ['POST', `/api/v2/sites/yuanxuai/${name}`, payload, undefined, undefined]));
});

test('预览统一错误文案，提交和查询提取错误文本，不跟随重定向', async t => {
  const mock = express().use(express.json());
  const order = { job_id: 'mock-id', status: 'pending', plan: 'plus', plan_label: 'Plus', account_email: 'demo@example.test', created_at: '2026-01-01T00:00:00Z' };
  let redirected = false;
  mock.post('/api/v2/sites/yuanxuai/preview', (req, res) => {
    switch (req.body.redeem_code) {
      case 'redirect': res.redirect(307, '/redirect-target'); break;
      case 'timeout': break; // No response: exercise the adapter's real HTTP timeout.
      case 'invalid-code': res.status(400).json({ detail: '内部预览错误' }); break;
      case 'oversize': res.json({ extra: 'x'.repeat(124_000) }); break;
      default: res.type('application/json').send('{bad-json');
    }
  });
  mock.post('/redirect-target', (_req, res) => { redirected = true; res.sendStatus(200); });
  mock.post('/api/v2/sites/yuanxuai/submit', (req, res) => {
    switch (req.body.redeem_code) {
      case 'bad-status': res.json({ ...order, status: 'internal-status' }); break;
      case 'bad-date': res.json({ ...order, created_at: '2026-02-30T00:00:00Z' }); break;
      case 'wrapped': res.json({ job: order }); break;
      case 'no-card': res.status(409).json({ detail: { code: 'no_available_card', message: 'private' } }); break;
      default: res.status(500).set('X-Private', 'secret').json({ detail: '充值通道暂时关闭' });
    }
  });
  mock.post('/api/v2/sites/yuanxuai/lookup', (req, res) => {
    switch (req.body.redeem_code) {
      case 'validate': res.status(422).json({ detail: [{ loc: ['body', 'redeem_code'], msg: '字段无效', input: 'SECRET' }] }); break;
      case 'message': res.status(409).json({ detail: { message: '订单状态暂不可查', code: 'conflict' } }); break;
      case 'code-only': res.status(409).json({ detail: { code: 'query_not_ready' } }); break;
      case 'html': res.status(503).type('html').send('<html>代理异常</html>'); break;
      case 'echoed-code': res.status(400).type('text').send('无效卡密：echoed-code'); break;
      default: res.status(503).type('text').send('查询通道维护中');
    }
  });
  const api = await start(t, mock, 100);
  for (const redeem_code of ['redirect', 'timeout', 'invalid-json', 'oversize', 'invalid-code', '']) {
    const response = await api('/api/preview', { redeem_code });
    assert.equal(response.status, redeem_code === 'timeout' ? 504 : !redeem_code || redeem_code === 'invalid-code' ? 400 : 502);
    assert.deepEqual(await response.json(), { detail: 'cdk 验证失败' });
  }
  assert.equal(redirected, false);
  for (const redeem_code of ['bad-status', 'bad-date', 'wrapped', 'upstream-failure', 'no-card']) {
    const response = await api('/api/submit', { redeem_code, chatgpt_token: session, turnstile_token: null, request_id: randomUUID() });
    assert.equal(response.headers.get('X-Private'), null);
    assert.equal(response.status, redeem_code === 'no-card' ? 409 : redeem_code === 'upstream-failure' ? 500 : 502);
    assert.deepEqual(await response.json(), { detail: redeem_code === 'no-card' ?
      { code: 'no_available_card', message: '暂无可用卡片，请联系商家。' } : redeem_code === 'upstream-failure' ? '充值通道暂时关闭' : '充值服务暂不可用，请稍后重试。' });
  }
  for (const [redeem_code, status, detail] of [
    ['validate', 422, 'redeem_code：字段无效'], ['message', 409, '订单状态暂不可查'],
    ['code-only', 409, 'query_not_ready'], ['maintenance', 503, '查询通道维护中'],
    ['html', 503, '充值服务暂不可用，请稍后重试。'], ['echoed-code', 400, '充值服务暂不可用，请稍后重试。'],
  ] as const) {
    const response = await api('/api/lookup', { redeem_code });
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { detail });
  }
});

test('生产协议保留完整 Session 和可选令牌，公开订单号跨实例一致', async t => {
  const origin = 'https://upstream.example.test';
  const config = { mode: 'production' as const, apiPort: 0, upstreamOrigin: origin };
  const sessionWithExtra = '{"user":{"email":"member@example.test"}, "accessToken":"test-token", "extra":"fixture"}';
  const submit = { redeem_code: 'DEMO', chatgpt_token: sessionWithExtra, request_id: randomUUID(), turnstile_token: 'test-challenge' };
  const order = { job_id: 'internal-job', status: 'pending', plan: 'plus', plan_label: 'Plus', account_email: 'member@example.test', created_at: '2026-01-01T00:00:00Z' };
  const calls: unknown[] = [];
  let latest = order;
  const firstPort = await listen(t, createSiteApi(config, 4000, async (url, init) => {
    calls.push([url, init?.method, init?.headers, init?.redirect, JSON.parse(String(init?.body))]);
    if (String(url).endsWith('/preview')) return Response.json({ plan: 'plus', plan_label: 'Plus', region: 'PH', expires_at: null });
    return Response.json(order);
  }));
  const nextPort = await listen(t, createSiteApi(config, 4000, async (url, init) => {
    calls.push([url, init?.method, init?.headers, init?.redirect, JSON.parse(String(init?.body))]);
    return Response.json({ job: latest, message: 'internal-response' });
  }));
  const json = { 'Content-Type': 'application/json' };
  const body = { redeem_code: submit.redeem_code };
  const preview = await fetch(`http://127.0.0.1:${firstPort}/api/preview`, { method: 'POST', headers: json, body: JSON.stringify(body) });
  assert.equal(preview.status, 200);
  const created = await fetch(`http://127.0.0.1:${firstPort}/api/submit`, {
    method: 'POST', headers: { ...json, Authorization: 'private' }, body: JSON.stringify({ ...submit, chatgpt_token: ` ${sessionWithExtra} ` }),
  });
  assert.equal(created.status, 200);
  const job = await created.json();
  const url = `http://127.0.0.1:${nextPort}/api/lookup`;
  const request = { method: 'POST', headers: json, body: JSON.stringify(body) };
  assert.deepEqual((await (await fetch(url, request)).json()).job, job);
  latest = { ...order, job_id: 'another-job' };
  assert.notEqual((await (await fetch(url, request)).json()).job.job_id, job.job_id);
  assert.deepEqual(calls, [['preview', body], ['submit', submit], ['lookup', body], ['lookup', body]].map(([operation, payload]) =>
    [`${origin}/api/v2/sites/yuanxuai/${operation}`, 'POST', json, 'error', payload]));
});
