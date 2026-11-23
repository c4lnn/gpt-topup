import { randomUUID } from 'node:crypto';
import express from 'express';

const prefix = '/api/v2/sites/yuanxuai';
const codes = ['DEMO', 'FAIL', 'CANCEL', 'PENDING', 'MANUAL', 'NO-CARD'];
const preview = { plan: 'plus', plan_label: 'Plus', region: 'PH', expires_at: null };

const fixtureEmail = 'demo@example.test';
const fixtureToken = 'mock-session-local-only';
type Status = 'pending' | 'processing' | 'verifying' | 'manual_review' | 'succeeded' | 'failed' | 'cancelled';
const timelines: Record<string, Status[]> = {
  DEMO: ['pending', 'processing', 'succeeded'], FAIL: ['pending', 'failed'],
  CANCEL: ['pending', 'cancelled'], PENDING: ['pending'], MANUAL: ['verifying', 'manual_review'],
};
function getFixture(code: unknown) {
  return typeof code === 'string' ? codes.find(suffix => code.trim() === `YUANXUAI-${suffix}`) : undefined;
}
function isFixtureSession(raw: unknown) {
  if (typeof raw !== 'string' || raw.length > 100_000) return false;
  try {
    const data = JSON.parse(raw);
    return data?.user?.email === fixtureEmail && data?.accessToken === fixtureToken;
  } catch { return false; }
}
type Order = { id: string; created: string; finished?: string; index: number; timeline: Status[] };
function orderResult(order: Order) {
  const status = order.timeline[order.index];
  return { job_id: order.id, status, plan: preview.plan, plan_label: preview.plan_label,
    account_email: fixtureEmail, created_at: order.created, finished_at: order.finished,
    fail_reason: status === 'failed' ? '模拟充值失败。' : status === 'cancelled' ? '模拟订单已取消。' : undefined,
    subscription_verification_reason: status === 'manual_review' ? '请人工核实模拟订单。' : undefined };
}

export function createApp() {
  const app = express();
  const latest = new Map<string, Order>();
  const requests = new Map<string, Order>();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '120kb' }));
  app.post(`${prefix}/preview`, (req, res) => {
    if (!getFixture(req.body?.redeem_code)) {
      res.status(400).json({ detail: '卡密无效或不属于本站。' }); return;
    }
    res.json(preview);
  });
  app.post(`${prefix}/submit`, (req, res) => {
    const fixture = getFixture(req.body?.redeem_code);
    const id = req.body?.request_id;
    if (!fixture || typeof id !== 'string' || !/^[\w-]{1,128}$/.test(id) || !isFixtureSession(req.body?.chatgpt_token)) {
      res.status(400).json({ detail: '请使用有效的模拟卡密、请求标识和示例 Session。' }); return;
    }
    if (fixture === 'NO-CARD') { res.status(409).json({ detail: { code: 'no_available_card', message: '暂无可用卡片，请联系商家。' } }); return; }
    const requestKey = `${fixture}:${id}`;
    let order = requests.get(requestKey);
    if (!order) {
      order = { id: randomUUID(), created: new Date().toISOString(), index: 0, timeline: timelines[fixture] };
      requests.set(requestKey, order);
      latest.set(fixture, order);
    }
    res.json(orderResult(order));
  });
  app.post(`${prefix}/lookup`, (req, res) => {
    const fixture = getFixture(req.body?.redeem_code);
    if (!fixture) { res.status(400).json({ detail: '卡密无效或不属于本站。' }); return; }
    const order = latest.get(fixture);
    if (!order) { res.json({ job: null, message: '未查询到充值订单。' }); return; }
    if (order.index + 1 < order.timeline.length) {
      order.index++;
      if (['succeeded', 'failed', 'cancelled'].includes(order.timeline[order.index])) order.finished = new Date().toISOString();
    }
    res.json({ job: orderResult(order), message: '已查询到最近一次充值订单。' });
  });
  const invalidBody: express.ErrorRequestHandler = (_error, _req, res, _next) => {
    res.status(400).json({ detail: '请求正文格式无效或过长。' });
  };
  app.use(invalidBody);
  return app;
}
