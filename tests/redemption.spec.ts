import { randomUUID } from 'node:crypto';
import { test as base, expect, type Page } from '@playwright/test';

const session = '{"user":{"email":"demo@example.test"},"accessToken":"mock-session-local-only"}';

const test = base.extend<{ localNetwork: void }>({
  localNetwork: [async ({ context, baseURL }, use) => {
    const denied: string[] = [];
    const origin = new URL(baseURL!);
    const isLocal = (url: string) => {
      const target = new URL(url);
      return target.host === origin.host && (target.protocol === 'http:' || target.protocol === 'ws:');
    };
    await context.route('**/*', route => {
      if (isLocal(route.request().url())) return route.continue();
      denied.push(new URL(route.request().url()).hostname);
      return route.abort();
    });
    await context.routeWebSocket('**/*', socket => {
      if (isLocal(socket.url())) socket.connectToServer();
      else { denied.push(new URL(socket.url()).hostname); void socket.close(); }
    });
    await use();
    expect(denied, '浏览器只能访问本站').toEqual([]);
  }, { auto: true }],
});

async function redeem(page: Page, code: string) {
  await page.getByLabel('卡密').fill(code);
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page.getByRole('heading', { name: '填写账号' })).toBeFocused();
}

async function query(page: Page, code: string) {
  await page.getByRole('tab', { name: '订单查询' }).click();
  await page.getByLabel('卡密').fill(code);
  await page.getByRole('button', { name: '查询订单' }).click();
}

test('窄屏直接显示兑换表单，支持键盘切换查询', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  const apiRequests: string[] = [];
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (path === '/api' || path.startsWith('/api/')) apiRequests.push(`${request.method()} ${path}`);
  });
  await page.goto('/');
  await expect(page.getByLabel('卡密')).toBeEditable();
  const first = page.getByRole('tab', { name: '兑换充值' });
  await first.focus();
  await first.press('ArrowRight');
  const second = page.getByRole('tab', { name: '订单查询' });
  await second.press('Enter');
  await expect(second).toBeFocused();
  await expect(page.getByLabel('卡密')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBe(375);
  await page.getByLabel('卡密').fill('YUANXUAI-NO-CARD');
  await page.getByRole('button', { name: '查询订单' }).click();
  await expect(page.getByText('未查询到充值订单。')).toBeVisible();
  expect(apiRequests.filter(request => request !== 'GET /api/runtime')).toEqual(['POST /api/lookup']);
});

test('卡密预览：无效、失败及返回', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('卡密').fill('INVALID');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page.getByText('cdk 验证失败')).toBeVisible();
  await redeem(page, 'YUANXUAI-DEMO');
  await page.getByRole('button', { name: '上一步' }).click();
  await expect(page.getByLabel('卡密')).toHaveValue('YUANXUAI-DEMO');
  await redeem(page, 'YUANXUAI-FAIL');
});

test('忽略 URL 中的卡密，只在手动提交后验证', async ({ page }) => {
  const previews: string[] = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/preview') previews.push(request.postDataJSON().redeem_code);
  });
  await page.goto('/?cdk=YUANXUAI-DEMO');
  await expect(page.getByRole('heading', { name: '验证卡密' })).toBeVisible();
  await expect(page.getByLabel('卡密')).toBeEmpty();
  await page.goto('/?cdk=YUANXUAI-DEMO#cdk=YUANXUAI-FAIL');
  await expect(page.getByLabel('卡密')).toBeEmpty();
  await redeem(page, 'YUANXUAI-NO-CARD');
  expect(previews).toEqual(['YUANXUAI-NO-CARD']);
});

test('Session 验证、请求重试去重及离开清空', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(crypto, 'randomUUID', { value: undefined }));
  await page.goto('/');
  await redeem(page, 'YUANXUAI-NO-CARD');
  const ids: string[] = [];
  await page.route('**/api/submit', route => {
    ids.push(route.request().postDataJSON().request_id);
    return route.fulfill({ status: 503, json: { detail: '暂时不可用' } });
  });
  const input = page.getByLabel('Session JSON');
  const submit = page.getByRole('button', { name: '开始充值' });
  const label = page.locator('label[for="session"]');
  const normalLabelColor = await label.evaluate(element => getComputedStyle(element).color);
  await input.fill('{}');
  await submit.click();
  await expect(page.getByText('Session JSON 必须包含邮箱和 accessToken。')).toBeVisible();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  expect(ids).toEqual([]);
  await input.fill(session);
  await expect(page.getByText('当前账号：demo@example.test')).toBeVisible();
  for (let i = 0; i < 2; i++) {
    await submit.click();
    await expect(page.getByText(/请先通过查询核对订单/)).toBeVisible();
    await expect(input).toHaveAttribute('aria-invalid', 'false');
    await expect(label).toHaveCSS('color', normalLabelColor);
  }
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
  expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  await input.fill(` ${session} `);
  await submit.click();
  await expect(page.getByText(/请先通过查询核对订单/)).toBeVisible();
  expect(ids[2]).toBe(ids[0]);
  await input.fill(JSON.stringify(JSON.parse(await input.inputValue()), null, 2));
  await submit.click();
  await expect(page.getByText(/请先通过查询核对订单/)).toBeVisible();
  expect(ids[3]).not.toBe(ids[2]);
  await page.getByRole('tab', { name: '订单查询' }).click();
  await page.getByRole('tab', { name: '兑换充值' }).click();
  await redeem(page, 'YUANXUAI-NO-CARD');
  await expect(input).toBeEmpty();
  await input.fill(session);
  await submit.click();
  await expect(page.getByText(/请先通过查询核对订单/)).toBeVisible();
  expect(ids[4]).not.toBe(ids[0]);
  await page.unroute('**/api/submit');
  await input.fill(session);
  await submit.click();
  await expect(page.getByText('暂无可用卡片，请联系商家。')).toBeVisible();
});

test('轮询按 2/5 秒调度、恢复并在人工核验时停止', async ({ page }) => {
  await page.goto('/');
  await redeem(page, 'YUANXUAI-MANUAL');
  await page.clock.install();
  let count = 0;
  await page.route('**/api/lookup', route => ++count === 1 ? route.abort() : route.continue());
  await page.getByLabel('Session JSON').fill(session);
  await page.getByRole('button', { name: '开始充值' }).click();
  await expect(page.getByText('订阅核验中')).toBeVisible();
  await page.clock.runFor(1990);
  expect(count).toBe(0);
  await page.clock.runFor(20);
  await expect(page.getByText(/正在重试/)).toBeVisible();
  expect(count).toBe(1);
  await page.clock.runFor(5000);
  await expect(page.getByText('待人工核验')).toBeVisible();
  await page.clock.runFor(10000);
  expect(count).toBe(2);
  await page.getByRole('button', { name: '刷新结果' }).click();
  await expect.poll(() => count).toBe(3);
});

test('在途查询不并发，同一订单状态变化后重置为 2 秒', async ({ page }) => {
  await page.goto('/');
  await redeem(page, 'YUANXUAI-DEMO');
  const now = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time: now });
  await page.clock.pauseAt(new Date(now.getTime() + 1000));
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const requests: string[] = [];
  await page.route('**/api/lookup', async route => {
    requests.push(route.request().postData()!);
    if (requests.length === 1) {
      intercepted.resolve();
      await release.promise;
    }
    await route.continue();
  });
  await page.getByLabel('Session JSON').fill(session);
  await page.getByRole('button', { name: '开始充值' }).click();
  await expect(page.getByText('等待处理', { exact: true })).toBeVisible();
  await page.clock.runFor(1999);
  expect(requests).toEqual([]);
  await page.clock.runFor(1);
  try {
    await intercepted.promise;
    await page.getByRole('button', { name: '刷新结果' }).click();
    await page.clock.runFor(5000);
    expect(requests).toHaveLength(1);
  } finally { release.resolve(); }
  await expect(page.getByText('充值处理中', { exact: true })).toBeVisible();
  await page.clock.runFor(1999);
  expect(requests).toHaveLength(1);
  await page.clock.runFor(1);
  await expect(page.getByText('订阅成功')).toBeVisible();
  await page.clock.runFor(10000);
  expect(requests.map(body => JSON.parse(body))).toEqual(Array(2).fill({ redeem_code: 'YUANXUAI-DEMO' }));
});

test('刷新查到同一卡密的另一笔订单时保留当前结果', async ({ page }) => {
  await page.goto('/');
  await redeem(page, 'YUANXUAI-FAIL');
  await page.getByLabel('Session JSON').fill(session);
  await page.getByRole('button', { name: '开始充值' }).click();
  await expect(page.getByText('充值失败', { exact: true })).toBeVisible();
  const jobId = page.getByText('订单号', { exact: true }).locator('+ dd');
  const original = await jobId.innerText();
  const replacement = await page.request.post('/api/submit', { data: {
    redeem_code: 'YUANXUAI-FAIL', chatgpt_token: session, request_id: randomUUID(), turnstile_token: null,
  } });
  expect(replacement.ok()).toBe(true);
  const latest = (await replacement.json()).job_id;
  expect(latest).not.toBe(original);

  await page.getByRole('button', { name: '刷新结果' }).click();
  await expect(page.getByText('未查询到当前订单的更新。')).toBeVisible();
  await expect(jobId).toHaveText(original);

  await query(page, 'YUANXUAI-FAIL');
  await expect(jobId).toHaveText(latest);
});

test('离开结果后忽略在途轮询', async ({ page }) => {
  await page.goto('/');
  await redeem(page, 'YUANXUAI-PENDING');
  const intercepted = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  await page.route('**/api/lookup', async route => {
    intercepted.resolve();
    await release.promise;
    await route.fulfill({ json: { job: null, message: '旧查询结果' } });
  });
  await page.getByLabel('Session JSON').fill(session);
  await page.getByRole('button', { name: '开始充值' }).click();
  try {
    await intercepted.promise;
    await page.getByRole('tab', { name: '订单查询' }).click();
  } finally { release.resolve(); }
  await page.unrouteAll({ behavior: 'wait' });
  await expect(page.getByRole('heading', { name: '查询充值结果' })).toBeVisible();
  await expect(page.getByText('旧查询结果')).toHaveCount(0);
});

test('查询空态和错误保留输入', async ({ page }) => {
  await page.goto('/');
  await query(page, 'YUANXUAI-NO-CARD');
  await expect(page.getByText('未查询到充值订单。')).toBeVisible();
  await expect(page.getByLabel('卡密')).toHaveValue('YUANXUAI-NO-CARD');
  await page.getByLabel('卡密').fill('INVALID');
  await page.getByRole('button', { name: '查询订单' }).click();
  await expect(page.getByText('卡密无效或不属于本站。')).toBeVisible();
  await expect(page.getByLabel('卡密')).toBeEditable();
});

test('320 × 480 卡密校验失败后，提交按钮仍完整位于首屏', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 480 });
  await page.goto('/');
  await page.getByLabel('卡密').fill('INVALID');
  const submit = page.getByRole('button', { name: '验证并继续' });
  await expect(submit).toBeInViewport({ ratio: 1 });
  await submit.click();
  await expect(page.getByText('cdk 验证失败')).toBeVisible();
  await expect(submit).toBeInViewport({ ratio: 1 });
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
  expect(await submit.evaluate(element => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return element.contains(document.elementFromPoint(x + width / 2, y + height / 2));
  })).toBe(true);
});

for (const width of [1280, 375]) {
  test(`完整兑换与查询结果（${width}px）`, async ({ page }, info) => {
    const height = width === 375 ? 800 : 850;
    await page.setViewportSize({ width, height });
    const heading = page.getByRole('heading', { level: 1 });
    const position = (element: Element) => {
      const { x, y } = element.getBoundingClientRect();
      return { x: x + window.scrollX, y: y + window.scrollY };
    };
    const tabs = page.getByRole('tablist');
    const operation = page.locator('[data-operation]:visible');
    const panel = page.locator('.redemption-panel:visible');
    const operationPositions = new Map<string, { x: number; y: number }>();
    let panelBounds: { x: number; y: number; width: number; height: number } | undefined;
    const snapshot = async (name: string) => {
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
      expect(await page.evaluate(() => ({ top: window.scrollY, height: document.documentElement.scrollHeight }))).toEqual({ top: 0, height });
      const bounds = await panel.boundingBox();
      expect(bounds).not.toBeNull();
      panelBounds ??= bounds!;
      expect(bounds).toEqual(panelBounds);
      await expect(panel).toBeInViewport({ ratio: 1 });
      for (const control of await operation.locator('button, input, textarea').all()) {
        await expect(control).toBeInViewport({ ratio: 1 });
      }
      expect(await tabs.evaluate(position)).toEqual(tabsPosition);
      const tab = await page.getByRole('tab', { selected: true }).innerText();
      if (tab === '订单查询') {
        const content = (await operation.boundingBox())!;
        expect(content.x + content.width / 2).toBeCloseTo(bounds!.x + bounds!.width / 2);
      }
      const current = await operation.evaluate(position);
      if (operationPositions.has(tab)) expect(current).toEqual(operationPositions.get(tab));
      else operationPositions.set(tab, current);
      await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
      expect(await heading.evaluate(position)).toEqual(headingPosition);
    };
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '验证卡密' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    const headingPosition = await heading.evaluate(position);
    const tabsPosition = await tabs.evaluate(position);
    await snapshot('1-cdk');
    const field = await page.getByLabel('卡密').boundingBox();
    const action = await page.getByRole('button', { name: '验证并继续' }).boundingBox();
    expect(action!.x + action!.width).toBe(field!.x + field!.width);
    if (width === 375) expect(action!.width).toBe(field!.width);
    await redeem(page, 'YUANXUAI-DEMO');
    await expect(page.getByRole('link', { name: 'Session 页面' })).toHaveAttribute('href', 'https://chatgpt.com/api/auth/session');
    const account = operation.getByRole('status');
    await expect(account).toHaveText('当前账号：请先填写 Session');
    const submitPosition = await page.getByRole('button', { name: '开始充值' }).evaluate(position);
    await snapshot('2-account');
    const sessionInput = page.getByLabel('Session JSON');
    const emptyHeight = (await sessionInput.boundingBox())!.height;
    await sessionInput.fill('{}');
    await expect(account).toHaveText('当前账号：未能解析账号邮箱');
    expect(await page.getByRole('button', { name: '开始充值' }).evaluate(position)).toEqual(submitPosition);
    await sessionInput.fill(session);
    await expect(page.getByText('当前账号：demo@example.test')).toBeVisible();
    expect(await page.getByRole('button', { name: '开始充值' }).evaluate(position)).toEqual(submitPosition);
    const longSession = JSON.parse(session);
    longSession.user.email = `${'a'.repeat(64)}@example.test`;
    await sessionInput.fill(JSON.stringify({ ...longSession, fixture: Array(20).fill('local-test-only') }, null, 2));
    await expect(account).toHaveText(`当前账号：${longSession.user.email}`);
    expect((await sessionInput.boundingBox())!.height).toBe(emptyHeight);
    expect(await page.getByRole('button', { name: '开始充值' }).evaluate(position)).toEqual(submitPosition);
    await sessionInput.press('Control+End');
    expect(await sessionInput.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
    await snapshot('2-account-scrolled');
    await sessionInput.fill(session);
    await snapshot('2-account-filled');
    await page.getByRole('button', { name: '开始充值' }).click();
    await expect(page.getByText('等待处理', { exact: true })).toBeVisible();
    const finishedAt = page.getByText('完成时间', { exact: true }).locator('+ dd');
    await expect(page.getByText('完成时间', { exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '返回兑换' })).toHaveCount(0);
    const refresh = page.getByRole('button', { name: '刷新结果' });
    await refresh.focus();
    const before = await refresh.evaluate(position);
    await snapshot('3-pending');
    await expect(page.getByText('充值处理中', { exact: true })).toBeVisible();
    await snapshot('3-processing');
    expect(await refresh.evaluate(position)).toEqual(before);
    await expect(page.getByText('订阅成功')).toBeVisible({ timeout: 12000 });
    await expect(finishedAt).toHaveText(/\d/);
    await snapshot('3-result');
    expect(await refresh.evaluate(position)).toEqual(before);
    await expect(refresh).toBeFocused();
    await expect(page.getByRole('button', { name: '返回兑换' })).toBeVisible();
    const order = await page.locator('dd').nth(2).innerText();
    await page.getByRole('tab', { name: '订单查询' }).click();
    await expect(page.getByRole('heading', { name: '查询充值结果' })).toBeVisible();
    await snapshot('4-query');
    await query(page, 'YUANXUAI-DEMO');
    await expect(page.getByRole('heading', { name: '订单结果' })).toBeFocused();
    await expect(page.getByRole('tab', { name: '订单查询' })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('dd').nth(2)).toHaveText(order);
    await snapshot('5-query-result');
    await page.getByRole('tab', { name: '兑换充值' }).click();
    await redeem(page, 'YUANXUAI-MANUAL');
    await page.getByLabel('Session JSON').fill(session);
    await page.getByRole('button', { name: '开始充值' }).click();
    await expect(page.getByText('订阅核验中')).toBeVisible();
    await refresh.focus();
    expect(await refresh.evaluate(position)).toEqual(before);
    await expect(page.getByText('待人工核验')).toBeVisible();
    await snapshot('6-manual-review');
    expect(await refresh.evaluate(position)).toEqual(before);
    await expect(refresh).toBeFocused();
    await expect(page.getByRole('button', { name: '返回兑换' })).toHaveCount(0);
  });
}

test('模式由服务端配置决定，请求参数不能修改模式', async ({ page }, info) => {
  const mock = info.project.name === 'mock';
  await page.goto(`/?mock=${!mock}`);
  const badge = page.getByText('Mock 模式', { exact: true });
  await page.getByLabel('卡密').fill('YUANXUAI-DEMO');
  await expect(page.getByRole('button', { name: '验证并继续' })).toBeEnabled();
  await expect(badge).toHaveCount(mock ? 1 : 0);
  const response = await page.request.get('/api/runtime?mock=' + !mock, { headers: { 'X-Mock': String(!mock) } });
  expect(response.headers()['cache-control']).toBe('no-store');
  expect(await response.json()).toEqual({ mock });
});

test('无法确认模式时禁止兑换及查询', async ({ page }) => {
  await page.route('**/api/runtime', route => route.fulfill({ json: { mock: 'false' } }));
  await page.goto('/');
  await expect(page.getByRole('alert')).toContainText('无法确认服务状态');
  await page.getByLabel('卡密').fill('YUANXUAI-DEMO');
  await expect(page.getByRole('button', { name: '验证并继续' })).toBeDisabled();
  await page.getByRole('tab', { name: '订单查询' }).click();
  await page.getByLabel('卡密').fill('YUANXUAI-DEMO');
  await expect(page.getByRole('button', { name: '查询订单' })).toBeDisabled();
});

test('生产上游故障返回本站错误', async ({ page }, info) => {
  test.skip(info.project.name !== 'production', '只验证正式适配路径');
  await page.goto('/');
  await page.getByLabel('卡密').fill('UPSTREAM-OFFLINE');
  await page.getByRole('button', { name: '验证并继续' }).click();
  await expect(page.getByText('cdk 验证失败')).toBeVisible();
});
