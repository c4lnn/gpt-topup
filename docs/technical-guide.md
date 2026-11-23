# GPT 代充中心技术文档

## 系统架构

本站提供 GPT 账号充值和订单查询，卡密（CDK）是提交充值及查单的凭证。本站负责表单、接口适配和结果展示，不维护生产订单数据库；生产订单由站点上游 `/api/v2/sites/yuanxuai` 受理，不走 `/api/v1` 商户下单接口。

```text
开发：浏览器 → Vite :5173 ── /api 代理 ──→ 本站 API :8787 → 本地 mocker :8788
生产：浏览器 → HTTPS 反向代理 ───────────→ 本站 API :8787 → HTTPS 生产上游
                                          └── 提供 Web 静态构建产物
```

| 模块 | 职责 | 代码入口 |
| --- | --- | --- |
| Web | React 表单、兑换步骤、查询入口和订单回执；业务请求只走同源 `/api` | [`App.tsx`](../apps/web/src/App.tsx)、[`api.ts`](../apps/web/src/api.ts) |
| 本站 API | 验证并重建请求，调用固定上游，规范化响应和错误 | [`site-api.ts`](../apps/mock/src/site-api.ts) |
| 启动入口 | 开发时启动 Vite、本站 API 和 mocker；生产时提供静态文件和本站 API，不启动 Vite 或 mocker | [`dev.mjs`](../scripts/dev.mjs)、[`site-server.ts`](../apps/mock/src/site-server.ts) |
| 本地 mocker | 模拟同一套上游接口；仅使用演示凭据，订单保存在进程内存中，重启清空 | [`app.ts`](../apps/mock/src/app.ts) |

`npm run dev` 固定为 mock；`npm run build` 后执行 `npm start` 固定为生产。端口和生产上游源由 [`runtime-config.ts`](../apps/mock/src/runtime-config.ts) 固定，不需要 `.env`，不会在上游失败时切换模式。两种模式共用 `127.0.0.1:8787`，不能同时启动。页面初始化时读取 `GET /api/runtime`；只有成功确认模式后才允许执行业务请求，mock 模式显示标记。

GitHub Actions 构建生产镜像并发布到 GHCR；部署端用 Docker Compose 拉取镜像，不在宿主机构建。容器内监听 `0.0.0.0:8787`，宿主机只发布到 `127.0.0.1:8787`，由宿主机 HTTPS 反向代理接入。部署命令见 [README](../README.md#docker-compose-部署)。

## 本站 API

| 本站接口 | JSON 请求字段 | 成功响应 | 上游路径后缀 |
| --- | --- | --- | --- |
| `GET /api/runtime` | 无 | `{ "mock": boolean }` | 不调用上游 |
| `POST /api/preview` | `redeem_code` | 套餐、地区、到期时间 | `/preview` |
| `POST /api/submit` | `redeem_code`、`chatgpt_token`、`request_id`、`turnstile_token` | 订单对象；表示已取得订单回执，不保证订阅成功 | `/submit` |
| `POST /api/lookup` | `redeem_code` | `{ job, message }`；无订单时 `job` 为 `null` | `/lookup` |

本站只转发表中列出的请求字段，不转发客户端请求头。卡密去掉首尾空白后须非空且不超过 128 字符。上游超时返回 HTTP `504`；连接失败、重定向或无法解析的成功响应返回 `502`。

`/api/preview` 的错误统一返回 `{"detail":"cdk 验证失败"}`。`/api/submit` 和 `/api/lookup` 从上游 HTTP 错误提取 `detail` 字符串、`detail.message`、`detail.code`、字段校验消息或 `text/plain` 文本，统一放入本站的 `detail`；没有可用文案时返回通用提示，不转发上游响应头。自动轮询失败时保留当前订单并提示重试。

## 充值流程

1. **验证卡密。** 用户手动填写 CDK，页面调用 `/api/preview`。成功后进入账号步骤并展示套餐和地区；此操作不创建订单。
2. **填写账号。** 页面和本站 API 检查 Session JSON 包含非空 `user.email` 和 `accessToken`；页面展示解析出的邮箱供核对。本地校验不代表上游接受该会话。
3. **开始充值。** 页面调用 `/api/submit`，把去掉首尾空白的完整 Session 作为 `chatgpt_token` 字符串提交，并发送 UUID v4 格式的 `request_id`。当前页面发送 `turnstile_token: null`，不会绕过上游挑战或拒绝。
4. **查看回执。** 拿到订单后页面清空 Session 输入，显示订单号、套餐、账号、状态和提交时间；完成时间仅在有数据时显示。提交失败且无法确认是否建单时，先用原卡密查询，不自动重提。

同一次提交在输入未变时重试会复用 `request_id`；修改 Session 内容或重新验证卡密会生成新标识。mocker 按卡密和 `request_id` 去重；**不能据此推断生产上游已经验证了幂等行为**。

## 订单查询与状态更新

- **独立查询：**「订单查询」按原卡密调用 `/api/lookup`，返回该卡密最近一笔订单；不需要 Session。无订单时留在表单显示提示。
- **回执刷新：** 提交和查询共用回执。前端比较查询返回的公开 `job_id` 与当前订单号；不同则提示未查询到当前订单的更新，不用新订单覆盖旧回执。公开订单号由服务端根据运行模式、上游源和上游订单 ID 生成，不直接展示上游原始 ID。
- **旧版回执：** 若仍打开着升级前的结果页，重新打开站点并按原卡密查询。
- **自动轮询：** 对处理中状态，回执打开约 2 秒后首次查询；后续状态变化时约 2 秒后再查，未变化或查询失败时约 5 秒后再查。离开回执会取消查询和定时器。用户也可手动刷新。

| 状态 | 自动轮询 | 页面含义 |
| --- | --- | --- |
| `pending`、`processing`、`verifying` | 继续 | 等待处理、充值处理中或订阅核验中，不重复充值 |
| `manual_review` | 停止，可手动刷新 | 待人工核验，不等于失败，不重复充值 |
| `succeeded`、`failed`、`cancelled` | 停止，可手动刷新 | 订阅成功、充值失败或订单已取消 |

## 上游 API 契约

生产模式访问固定的 HTTPS 上游，mock 模式只访问回环夹具。以下路径和报文描述上游契约；浏览器使用的同源接口见[本站 API](#本站-api)。

三个请求均使用 `Content-Type: application/json`。

### 卡密验证（`preview`）

`POST https://admin-lm.zdhxylc.shop/api/v2/sites/yuanxuai/preview`，无需 `X-API-Key`。

请求：

```json
{"redeem_code":"<CDK>"}
```

成功响应（HTTP `200`，无 `code/data` 包装）：

```json
{"plan":"plus","plan_label":"Plus","region":"PH","expires_at":null}
```

站点标识须与 CDK 所属站点一致。预览不消耗 CDK，也不返回使用状态；实际能否使用以创建订单时的校验为准。无效卡密或站点不可用返回 HTTP `400`；字段校验失败返回 `422`，错误见 `detail`。

### 提交充值（`submit`）

`POST https://admin-lm.zdhxylc.shop/api/v2/sites/yuanxuai/submit`

浏览器请求本站 `/api/submit`，由本站服务端调用上游。参考站请求未携带 `X-API-Key` 或 `Idempotency-Key`，请求标识通过 JSON 正文传递。

请求示例：

```json
{
  "redeem_code": "<CDK>",
  "chatgpt_token": "{\"user\":{\"email\":\"user@example.com\"},\"accessToken\":\"<accessToken>\"}",
  "request_id": "<本次提交的请求标识>",
  "turnstile_token": null
}
```

| 字段 | 参考站发送规则 |
| --- | --- |
| `redeem_code` | 去除首尾空白的原卡密。 |
| `chatgpt_token` | 去除首尾空白的完整 Session JSON **字符串**，不是嵌套对象。参考站前端检查 `user.email` 和非空 `accessToken`；上游完整校验规则尚未实测。 |
| `request_id` | 浏览器生成的 UUID v4，放在 JSON 请求体中。同一次提交未修改输入而重试时沿用原值。 |
| `turnstile_token` | Turnstile 验证令牌；没有令牌时参考站发送 `null`。 |

**`request_id` 生成与复用：**参考站优先使用 `globalThis.crypto.randomUUID()`；该方法不可用时，使用 `crypto.getRandomValues()` 生成 16 个随机字节，设置 UUID v4 的版本位和变体位，再格式化为 `8-4-4-4-12` 的字符串。卡密验证成功、Session 内容变更或重新开始兑换时生成新 ID。上游是否据此去重尚未实测；提交超时不代表未建单，应先查询，不自动重新提交。

成功响应示例（根据参考站前端读取逻辑还原，**不是生产实测报文**）：

```json
{
  "job_id": "<站点订单号>",
  "status": "pending",
  "plan": "plus",
  "plan_label": "Plus",
  "account_email": "user@example.com",
  "created_at": "2026-11-23T02:00:00Z"
}
```

`/submit` 的成功响应直接是顶层订单对象，不取 `job` 或 `data`。服务端按白名单转换成本站订单对象，浏览器用本站 `/api/submit` 的响应立即显示首次结果，不等待 `/lookup`。`pending` 表示已受理，不是充值成功。`detail.code: "no_available_card"` 继续使用本站固定提示；其他提交错误提醒先查单，不自动重提。

### 订单查询（`lookup`）

`POST https://admin-lm.zdhxylc.shop/api/v2/sites/yuanxuai/lookup`

参考站调用时未携带 `X-API-Key`。请求体使用提交充值时的原卡密，不传 `order_no`：

```json
{"redeem_code":"<原卡密>"}
```

有订单时的响应示例（根据参考站前端读取逻辑还原，**不是生产实测报文**）：

```json
{
  "job": {
    "job_id": "<站点订单号>",
    "status": "succeeded",
    "plan": "plus",
    "plan_label": "Plus",
    "account_email": "user@example.com",
    "created_at": "2026-11-23T02:00:00Z",
    "finished_at": "2026-11-23T02:00:12Z"
  },
  "message": "已查询到最近一次充值订单。"
}
```

- `lookup` 按原卡密查询最近一笔订单，不支持按订单号查询，也不接收 Session。上游无订单时是否固定返回 `job: null`、提示原文及时间格式尚未实测。
- 本站提交和查询响应均返回通过格式校验的完整 `account_email`。持有原卡密即可查询最近一笔订单的完整邮箱，无需额外验证账号身份。

无效卡密实测返回 HTTP `400`：

```json
{"detail":"卡密无效或不属于本站，请检查输入或联系商家"}
```

回执关联、刷新与轮询规则见[订单查询与状态更新](#订单查询与状态更新)。

## 凭据处理与离线验收

- Session 是账号凭据。提交时，本站会把完整 Session 转发给当前模式对应的上游；不要把真实 Session 或卡密放进示例、截图或测试。生产部署使用 HTTPS 入口，反向代理不得记录请求正文。
- 本站 API 不持久化 Session 或卡密；本地 mocker 仅维护演示订单和去重所需的内存状态。API 响应使用 `Cache-Control: no-store`，成功响应只返回规定的套餐或订单字段，不返回 Session 或令牌。
- [README](../README.md) 维护启动命令、演示卡密和验收命令。[mock 浏览器配置](../tests/playwright.config.ts) 启动 `npm run dev`；[生产浏览器配置](../tests/playwright.production.config.ts) 启动 `npm start`，用[本地夹具](../tests/production-upstream.mjs) 拦截生产上游请求。两套测试应顺序运行，离线通过不代表真实生产上游已联通。
