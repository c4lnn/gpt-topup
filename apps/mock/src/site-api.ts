import { createHash } from 'node:crypto';
import express from 'express';
import type { RuntimeConfig } from './runtime-config.js';

const path = '/api/v2/sites/yuanxuai';
const limit = 120 * 1024;
const statuses = ['pending', 'processing', 'verifying', 'manual_review', 'succeeded', 'failed', 'cancelled'];
const plans: Record<string, string> = { go: 'Go', plus: 'Plus', pro5: 'Pro 5', pro20: 'Pro 20', pro50: 'Pro 50' };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const unavailable = '充值服务暂不可用，请稍后重试。';
const noOrder = '未查询到充值订单。';
const previewFailure = 'cdk 验证失败';
type Json = Record<string, unknown>;

function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid object');
  return value as Json;
}

function validSession(raw: unknown): raw is string {
  if (typeof raw !== 'string') return false;
  try {
    const data = object(JSON.parse(raw));
    const user = object(data.user);
    return typeof user.email === 'string' && !!user.email.trim() && typeof data.accessToken === 'string' && !!data.accessToken.trim();
  } catch { return false; }
}

function date(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) throw new Error('Invalid timestamp');
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.valueOf()) || +value.slice(8, 10) < 1 ||
    +value.slice(8, 10) > new Date(Date.UTC(+value.slice(0, 4), +value.slice(5, 7), 0)).getUTCDate()) throw new Error('Invalid timestamp');
  return timestamp.toISOString();
}

function plan(data: Json) {
  if (typeof data.plan !== 'string' || !Object.hasOwn(plans, data.plan) || typeof data.plan_label !== 'string' || !data.plan_label.trim()) throw new Error('Invalid plan');
  return { plan: data.plan, plan_label: plans[data.plan] };
}

async function readText(response: Response) {
  if (!response.body) throw new Error('Invalid body');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return text + decoder.decode();
      size += chunk.value.byteLength;
      if (size > limit) throw new Error('Oversized body');
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally { await reader.cancel(); }
}

async function readJson(response: Response) {
  if (!/^application\/json\b/i.test(response.headers.get('content-type') ?? '')) {
    await response.body?.cancel();
    throw new Error('Invalid body');
  }
  return object(JSON.parse(await readText(response)));
}

function errorMessage(detail: unknown): string {
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) return detail.flatMap(item => {
    if (typeof item?.msg !== 'string') return [];
    const field = Array.isArray(item.loc) ? item.loc.at(-1) : undefined;
    return typeof field === 'string' ? `${field}：${item.msg}` : item.msg;
  }).join('；');
  if (detail && typeof detail === 'object') {
    if ('message' in detail && typeof detail.message === 'string') return detail.message;
    if ('code' in detail && typeof detail.code === 'string') return detail.code;
  }
  return '';
}

export function createSiteApi(config: RuntimeConfig, timeout = 4000, transport = fetch) {
  const origin = config.mode === 'mock' ? `http://127.0.0.1:${config.mockPort}` : config.upstreamOrigin;
  const app = express();
  app.disable('x-powered-by');
  app.enable('strict routing');
  app.enable('case sensitive routing');
  app.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.get('/api/runtime', (_req, res) => { res.json({ mock: config.mode === 'mock' }); });
  app.use(express.json({ limit, inflate: false }));
  for (const operation of ['preview', 'submit', 'lookup'] as const) {
    app.post(`/api/${operation}`, async (req, res) => {
      const code = typeof req.body?.redeem_code === 'string' ? req.body.redeem_code.trim() : '';
      if (!code || code.length > 128) { res.status(400).json({ detail: operation === 'preview' ? previewFailure : '请输入有效卡密。' }); return; }
      const body: Json = { redeem_code: code };
      if (operation === 'submit') {
        const { chatgpt_token, request_id, turnstile_token } = req.body;
        if (!validSession(chatgpt_token) || typeof request_id !== 'string' || !uuid.test(request_id) ||
          !(turnstile_token == null || typeof turnstile_token === 'string' && turnstile_token.trim())) {
          res.status(400).json({ detail: '请提交有效的 Session JSON 和请求标识。' }); return;
        }
        Object.assign(body, { chatgpt_token: chatgpt_token.trim(), request_id, turnstile_token: turnstile_token ?? null });
      }
      const signal = AbortSignal.timeout(timeout);
      try {
        const upstream = await transport(`${origin}${path}/${operation}`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), redirect: 'error', signal,
        });
        if (!upstream.ok) {
          const status = upstream.status >= 400 && upstream.status < 600 ? upstream.status : 502;
          if (operation === 'preview') {
            await upstream.body?.cancel();
            res.status(status).json({ detail: previewFailure });
            return;
          }
          let message = '';
          const type = upstream.headers.get('content-type') ?? '';
          if (/^application\/json\b/i.test(type)) {
            const { detail } = await readJson(upstream);
            if (operation === 'submit' && detail && typeof detail === 'object' && 'code' in detail && detail.code === 'no_available_card') {
              res.status(409).json({ detail: { code: 'no_available_card', message: '暂无可用卡片，请联系商家。' } });
              return;
            }
            message = errorMessage(detail);
          } else if (/^text\/plain\b/i.test(type)) {
            message = await readText(upstream);
          } else {
            await upstream.body?.cancel();
          }
          const session = typeof body.chatgpt_token === 'string' ? JSON.parse(body.chatgpt_token) : undefined;
          const sensitive = [code, origin, session?.accessToken, body.turnstile_token];
          message = message.trim();
          if (/^</.test(message) || sensitive.some(value => typeof value === 'string' && value && message.includes(value))) message = '';
          res.status(status).json({ detail: message || unavailable });
          return;
        }
        const data = await readJson(upstream);
        if (operation === 'preview') {
          if (typeof data.region !== 'string' || !/^[A-Z]{2}$/.test(data.region)) throw new Error('Invalid region');
          res.json({ ...plan(data), region: data.region, expires_at: data.expires_at === null ? null : date(data.expires_at) });
          return;
        }
        if (operation === 'lookup') {
          if (typeof data.message !== 'string') throw new Error('Invalid message');
          if (data.job === null) { res.json({ job: null, message: noOrder }); return; }
        }
        const raw = operation === 'submit' ? data : object(data.job);
        const { job_id, status, account_email } = raw;
        if (typeof job_id !== 'string' || !job_id.trim() || job_id.length > 256 || typeof status !== 'string' ||
          !statuses.includes(status) || typeof account_email !== 'string' || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(account_email)) throw new Error('Invalid order');
        const job = {
          job_id: createHash('sha256').update(JSON.stringify([config.mode, origin, job_id])).digest('hex').slice(0, 32), status, ...plan(raw), account_email,
          created_at: date(raw.created_at),
          finished_at: ['succeeded', 'failed', 'cancelled'].includes(status) && raw.finished_at != null ? date(raw.finished_at) : undefined,
          fail_reason: status === 'failed' ? '充值失败。' : status === 'cancelled' ? '订单已取消。' : undefined,
          subscription_verification_reason: status === 'manual_review' ? '请人工核实订单。' : status === 'verifying' && raw.subscription_verification_reason ? '正在核验订单。' : undefined,
        };
        res.json(operation === 'submit' ? job : { job, message: '已查询到最近一次充值订单。' });
      } catch {
        res.status(signal.aborted ? 504 : 502).json({ detail: operation === 'preview' ? previewFailure : unavailable });
      }
    });
  }
  const invalidBody: express.ErrorRequestHandler = (_error, req, res, _next) => {
    res.status(400).json({ detail: req.method === 'POST' && req.path === '/api/preview' ? previewFailure : '请求正文格式无效或过长。' });
  };
  app.use(invalidBody);
  return app;
}
