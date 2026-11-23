import { useEffect, useRef, useState, type FormEvent, type Ref } from 'react';
import { ArrowRight, CircleCheck, Clock3, CreditCard, RefreshCw, Search, TriangleAlert } from 'lucide-react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/spinner';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import { ApiError, api, errorText } from './api';

type Preview = { plan: string; plan_label: string; region: string; expires_at: string | null };
type Status = 'pending' | 'processing' | 'verifying' | 'manual_review' | 'succeeded' | 'failed' | 'cancelled';
type Job = { job_id: string; status: Status; plan: string; plan_label: string; account_email: string; created_at: string; finished_at?: string; fail_reason?: string; subscription_verification_reason?: string };
type Lookup = { job: Job | null; message: string };
type Result = { job: Job; code: string };
const statuses: Record<Status, string> = { pending: '等待处理', processing: '充值处理中', verifying: '订阅核验中', manual_review: '待人工核验', succeeded: '订阅成功', failed: '充值失败', cancelled: '订单已取消' };
const active = (status: Status) => ['pending', 'processing', 'verifying'].includes(status);
const dateFormat = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'medium' });

function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function readEmail(raw: string) {
  try {
    const data = JSON.parse(raw);
    if (typeof data?.user?.email === 'string' && typeof data.accessToken === 'string' && data.accessToken.trim()) return data.user.email.trim();
  } catch { /* incomplete input */ }
  return '';
}

export function App() {
  if (location.pathname === '/') return <SiteFlow />;
  return <main className="mx-auto grid min-h-svh max-w-xl content-center p-6">
    <Alert variant="destructive"><TriangleAlert /><AlertTitle>无法加载兑换站</AlertTitle><AlertDescription>站点地址无效。</AlertDescription></Alert>
  </main>;
}

function SiteFlow() {
  const [tab, setTab] = useState<'redeem' | 'lookup'>('redeem');
  const [code, setCode] = useState('');
  const [query, setQuery] = useState('');
  const [preview, setPreview] = useState<Preview>();
  const [session, setSession] = useState('');
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<'loading' | 'mock' | 'production' | 'error'>('loading');
  const ready = mode === 'mock' || mode === 'production';
  useEffect(() => {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(4000)]);
    void fetch('/api/runtime', { signal, redirect: 'error', cache: 'no-store' }).then(async response => {
      if (!response.ok) throw new Error();
      const data = await response.json();
      if (typeof data?.mock !== 'boolean' || Object.keys(data).length !== 1) throw new Error();
      if (!controller.signal.aborted) setMode(data.mock ? 'mock' : 'production');
    }).catch(() => { if (!controller.signal.aborted) setMode('error'); });
    return () => controller.abort();
  }, []);
  const request = useRef<AbortController | null>(null);
  const requestId = useRef<string | undefined>(undefined);
  const title = useRef<HTMLHeadingElement>(null);
  const focusNext = useRef(false);
  const view = result ? 'result' : tab === 'lookup' ? 'lookup' : preview ? 'account' : 'code';
  const email = readEmail(session);
  const sessionInvalid = !!error && !email;

  function clear() {
    request.current?.abort();
    request.current = null;
    requestId.current = undefined;
    setBusy(false); setError(''); setNotice(''); setSession(''); setPreview(undefined); setResult(undefined);
  }
  function switchTab(value: string) {
    clear(); setTab(value === 'lookup' ? 'lookup' : 'redeem');
  }
  async function perform<T>(path: string, body: object, apply: (data: T) => void, submit = false) {
    if (!ready || request.current) return;
    const controller = new AbortController();
    request.current = controller;
    setBusy(true); setError(''); setNotice('');
    try {
      const data = await api<T>(path, body, controller.signal);
      if (!controller.signal.aborted) apply(data);
    } catch (cause) {
      if (!controller.signal.aborted) {
        const advice = submit && !(cause instanceof ApiError && cause.code === 'no_available_card');
        setError(`${errorText(cause)}${advice ? ' 如无法确认是否已提交，请先通过查询核对订单。' : ''}`);
      }
    } finally {
      if (request.current === controller) { request.current = null; setBusy(false); }
    }
  }
  function validate(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return;
    if (trimmed.length > 128) { setError('卡密不得超过 128 个字符。'); return; }
    void perform<Preview>('/preview', { redeem_code: trimmed }, data => {
      requestId.current = newRequestId();
      focusNext.current = true; setCode(trimmed); setPreview(data);
    });
  }
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (focusNext.current) { focusNext.current = false; title.current?.focus(); }
  }, [view]);

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!email) { setError('Session JSON 必须包含邮箱和 accessToken。'); return; }
    if (request.current) return;
    requestId.current ??= newRequestId();
    void perform<Job>('/submit', { redeem_code: code, chatgpt_token: session.trim(), request_id: requestId.current, turnstile_token: null }, job => {
      focusNext.current = true; setSession(''); setResult({ job, code });
    }, true);
  }
  function lookup(event: FormEvent) {
    event.preventDefault();
    const trimmed = query.trim();
    if (!trimmed || trimmed.length > 128) return;
    void perform<Lookup>('/lookup', { redeem_code: trimmed }, data => {
      if (data.job) {
        focusNext.current = true; setResult({ job: data.job, code: trimmed });
      }
      else setNotice(data.message);
    });
  }
  const labels = { code: '验证卡密', account: '填写账号', lookup: '查询充值结果' };

  return <main className="redemption min-h-svh">
    <div className="mx-auto grid max-w-6xl gap-5 px-4 py-5 sm:px-8 sm:py-8">
      <header className="grid grid-cols-[auto_minmax(0,1fr)_6rem] items-center gap-3 border-b pb-5 sm:gap-4">
        <span className="grid size-12 shrink-0 place-items-center rounded-xl bg-primary text-primary-foreground"><CreditCard aria-hidden /></span>
        <h1 className="wrap-anywhere text-xl font-semibold leading-tight sm:text-2xl">GPT 代充中心</h1>
        {mode === 'mock' && <span className="justify-self-end rounded-full bg-muted px-2.5 py-1 text-sm font-medium text-muted-foreground">Mock 模式</span>}
      </header>
      <Tabs value={tab} onValueChange={switchTab} className="grid grid-cols-1 gap-5">
        <TabsList variant="line" aria-label="操作入口" className="redemption-tabs mb-1 w-full justify-start sm:w-fit">
          <TabsTrigger value="redeem"><CreditCard />兑换充值</TabsTrigger><TabsTrigger value="lookup"><Search />订单查询</TabsTrigger>
        </TabsList>
        {(['redeem', 'lookup'] as const).map(value => <TabsContent value={value} key={value} className="col-start-1 row-start-2 min-w-0">
          {value === tab && <div data-flow={tab} className="redemption-panel grid min-w-0 rounded-2xl border bg-card data-[flow=lookup]:justify-items-center md:data-[flow=redeem]:grid-cols-[14rem_minmax(0,1fr)] lg:data-[flow=redeem]:grid-cols-[17rem_minmax(0,1fr)]">
            {tab === 'redeem' && <aside className="redemption-guide rounded-t-[inherit] px-4 py-3 sm:px-6 md:rounded-tr-none md:rounded-bl-[inherit] md:px-6 md:py-8">
              <RedemptionSteps current={view === 'result' ? 2 : view === 'account' ? 1 : 0} />
            </aside>}
            <div data-operation className="grid w-full max-w-3xl min-w-0 content-start gap-4 p-4 sm:p-7 md:gap-6 md:p-8 lg:px-10">
              {view !== 'result' && <h2 id="operation-title" ref={title} tabIndex={-1} className="text-2xl leading-tight font-semibold sm:text-3xl">{labels[view]}</h2>}
              {mode === 'error' && <Alert variant="destructive" role="alert"><AlertDescription>无法确认服务状态，请刷新页面。</AlertDescription></Alert>}
              {result ? <ResultPanel key={`${result.code}:${result.job.job_id}`} result={result} titleRef={title} onReturn={() => {
                focusNext.current = true; clear(); setCode(''); setTab('redeem');
              }} /> : view === 'account' ? <form onSubmit={submit}>
                <FieldGroup className="gap-3 sm:gap-5">
                  <dl className="grid grid-cols-2 gap-3 rounded-lg border bg-muted/40 px-4 py-3">
                    <div className="min-w-0"><dt className="text-sm text-muted-foreground">套餐</dt><dd className="wrap-anywhere text-base font-medium">{preview?.plan_label || preview?.plan}</dd></div>
                    <div className="min-w-0"><dt className="text-sm text-muted-foreground">地区</dt><dd className="wrap-anywhere text-base font-medium">{preview?.region}</dd></div>
                  </dl>
                  <Field data-invalid={sessionInvalid}>
                    <FieldLabel htmlFor="session">Session JSON</FieldLabel>
                    <FieldDescription id="session-guide">在已登录 ChatGPT 的浏览器中打开 <a href="https://chatgpt.com/api/auth/session" target="_blank" rel="noopener noreferrer" className="font-semibold text-foreground">Session 页面</a>，将页面完整内容复制到下方。</FieldDescription>
                    <Textarea id="session" className="h-28 resize-none overflow-y-auto field-sizing-fixed" maxLength={100_000} autoComplete="off" spellCheck={false} aria-invalid={sessionInvalid} aria-describedby={error ? 'session-guide session-error' : 'session-guide'} disabled={busy} value={session} onChange={event => { if (event.target.value.trim() !== session.trim()) requestId.current = newRequestId(); setSession(event.target.value); setError(''); }} />
                    <FieldDescription role="status" aria-atomic="true" className="truncate" title={email || undefined}>当前账号：<strong className="font-semibold text-foreground">{email || (session.trim() ? '未能解析账号邮箱' : '请先填写 Session')}</strong></FieldDescription>
                    {error && <FieldError id="session-error" className="wrap-anywhere">{error}</FieldError>}
                  </Field>
                  <div className="flex flex-wrap items-center justify-between gap-3 border-t pt-3 sm:pt-4">
                    <Button type="button" variant="outline" size="lg" className="w-fit" disabled={busy} onClick={() => { focusNext.current = true; clear(); }}>上一步</Button>
                    <Button type="submit" size="lg" className="flex-1 sm:min-w-40 sm:flex-none" disabled={!ready || busy || !session.trim()}>{busy && <Spinner data-icon="inline-start" />}{busy ? '正在提交…' : '开始充值'}</Button>
                  </div>
                </FieldGroup>
              </form> : <form onSubmit={view === 'lookup' ? lookup : event => { event.preventDefault(); validate(code); }}>
                <FieldGroup className="gap-3">
                  <Field data-invalid={!!error}>
                    <FieldLabel htmlFor="redeem-code">{view === 'lookup' ? '原卡密' : '卡密'}</FieldLabel>
                    <Input id="redeem-code" autoComplete="off" maxLength={128} aria-invalid={!!error} aria-describedby={error ? 'redeem-error' : undefined} disabled={busy} value={view === 'lookup' ? query : code} onChange={event => { (view === 'lookup' ? setQuery : setCode)(event.target.value); setError(''); setNotice(''); }} />
                    <div className="min-h-5 wrap-anywhere">
                      {error && <FieldError id="redeem-error">{error}</FieldError>}
                    </div>
                  </Field>
                  <Button type="submit" size="lg" className="w-full self-end sm:w-fit sm:min-w-36" disabled={!ready || busy || !(view === 'lookup' ? query : code).trim()}>
                    {busy ? <Spinner data-icon="inline-start" /> : view === 'lookup' ? <Search data-icon="inline-start" /> : <ArrowRight data-icon="inline-start" />}
                    {busy ? '正在请求…' : view === 'lookup' ? '查询订单' : '验证并继续'}
                  </Button>
                  {notice && <Alert role="status"><AlertDescription className="wrap-anywhere">{notice}</AlertDescription></Alert>}
                </FieldGroup>
              </form>}
            </div>
          </div>}
        </TabsContent>)}
      </Tabs>
    </div>
  </main>;
}

function RedemptionSteps({ current }: { current: number }) {
  return <ol aria-label="兑换步骤" className="grid grid-cols-3 gap-2 md:grid-cols-1 md:gap-3">
    {['卡密', '账号', '结果'].map((step, i) => <li key={step} aria-current={current === i ? 'step' : undefined} className="redemption-step flex min-h-11 min-w-0 flex-wrap items-center gap-x-1 gap-y-0.5 rounded-lg px-1.5 py-2 md:gap-3 md:px-3">
      <span aria-hidden="true" className="redemption-step-number grid size-7 shrink-0 place-items-center rounded-full text-sm tabular-nums md:size-8">{i < current ? <CircleCheck className="size-5" /> : i + 1}</span>
      <span className="text-sm font-semibold md:text-base">{step}<span className="sr-only">{i < current ? '，已完成' : ''}</span></span>
    </li>)}
  </ol>;
}

function ResultPanel({ result, titleRef, onReturn }: { result: Result; titleRef: Ref<HTMLHeadingElement>; onReturn: () => void }) {
  const [job, setJob] = useState(result.job);
  const [error, setError] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const refresh = useRef<(() => void) | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    let timer: number | undefined;
    let status = result.job.status;
    let running = false;
    async function update(manual = false) {
      if (running) return;
      clearTimeout(timer);
      running = true;
      if (manual) setRefreshing(true);
      let delay = 5000;
      try {
        const data = await api<Lookup>('/lookup', { redeem_code: result.code }, controller.signal);
        if (controller.signal.aborted) return;
        if (!data.job) throw new ApiError(data.message);
        if (data.job.job_id !== result.job.job_id) throw new ApiError('未查询到当前订单的更新。');
        if (data.job.status !== status) delay = 2000;
        status = data.job.status;
        setJob(data.job); setError('');
      } catch (cause) {
        if (!controller.signal.aborted) setError(!manual && active(status) ? '暂时未能获取最新状态，正在重试。' : errorText(cause));
      } finally {
        running = false;
        if (!controller.signal.aborted) {
          if (manual) setRefreshing(false);
          if (active(status)) timer = window.setTimeout(update, delay);
        }
      }
    }
    refresh.current = () => void update(true);
    if (active(status)) timer = window.setTimeout(update, 2000);
    return () => { controller.abort(); clearTimeout(timer); refresh.current = null; };
  }, [result]);
  const awaiting = job.status === 'verifying' || job.status === 'manual_review';
  const danger = job.status === 'failed' || job.status === 'cancelled';
  const Icon = job.status === 'succeeded' ? CircleCheck : danger ? TriangleAlert : Clock3;
  return <div className="grid min-w-0 gap-3 sm:gap-5">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
      <h2 id="operation-title" ref={titleRef} tabIndex={-1} className="text-2xl leading-tight font-semibold sm:text-3xl">订单结果</h2>
      <Button variant="outline" size="lg" aria-disabled={refreshing} onClick={() => refresh.current?.()}>{refreshing ? <Spinner data-icon="inline-start" /> : <RefreshCw data-icon="inline-start" />}刷新结果</Button>
    </div>
    <Alert className="redemption-result" variant={danger ? 'destructive' : 'default'} role="status"><Icon /><AlertTitle>{statuses[job.status]}</AlertTitle>
      {job.fail_reason && <AlertDescription className="wrap-anywhere">{job.fail_reason}</AlertDescription>}
      {!job.fail_reason && (active(job.status) || awaiting) && <AlertDescription className="wrap-anywhere">
        {awaiting && job.subscription_verification_reason ? `${job.subscription_verification_reason} ` : ''}请勿重复充值。
      </AlertDescription>}
    </Alert>
    <dl className="grid min-w-0 rounded-lg border text-base">
      {[['套餐', job.plan_label || job.plan], ['账号', job.account_email || '待确认'], ['订单号', job.job_id], ['提交时间', dateFormat.format(new Date(job.created_at))], ...(job.finished_at ? [['完成时间', dateFormat.format(new Date(job.finished_at))]] : [])].map(([key, value]) =>
        <div className="grid min-w-0 grid-cols-[5rem_minmax(0,1fr)] gap-2 border-b px-3 py-2 last:border-b-0 sm:grid-cols-[6rem_minmax(0,1fr)] sm:px-4 sm:py-3" key={key}><dt className="text-sm leading-6 text-muted-foreground">{key}</dt><dd className="min-w-0 wrap-anywhere">{value}</dd></div>)}
    </dl>
    {error && <Alert variant="destructive"><AlertDescription className="wrap-anywhere">{error}</AlertDescription></Alert>}
    {!active(job.status) && job.status !== 'manual_review' && <Button size="lg" className="w-full sm:w-fit sm:justify-self-end" onClick={onReturn}>返回兑换</Button>}
  </div>;
}
