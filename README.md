# GPT 代充中心

需要 Node.js 22.12+。先运行 `npm ci`。启动命令决定模式，无需 `.env`。

- `npm run dev`：启动 Vite、本地 API（`127.0.0.1:8787`）和 mocker（`127.0.0.1:8788`）。访问 <http://127.0.0.1:5173/>。
- `npm start`：仅启动生产模式。先执行 `npm run build`，再启动服务。生产上游固定为 `https://admin-lm.zdhxylc.shop`，不回退到 mock。HTTPS 反向代理转发至 `127.0.0.1:8787`，不得记录兑换请求正文。

系统架构、充值与查单流程、API 契约见[技术文档](docs/technical-guide.md)。

## Docker Compose 部署

在 `compose.yaml` 所在目录执行：

```sh
docker compose pull
docker compose up -d
docker compose ps
curl http://127.0.0.1:8787/api/runtime
```

容器运行生产模式，检查应返回 `{"mock":false}`。部署端不构建镜像，无需安装 Node.js 或创建 `.env`。容器端口只发布到宿主机的 `127.0.0.1:8787`，将宿主机的 HTTPS 反向代理指向该地址，并禁用请求正文日志。健康检查只调用本站，不探测生产上游。如果 `8787` 已被本机的开发或生产进程占用，先停止该进程。

更新时重新执行 `docker compose pull` 和 `docker compose up -d`。用 `docker compose logs -f app` 查看日志，用 `docker compose down` 停止服务。

## 本地模拟

模拟环境只用虚构卡密及下面的演示 Session，手动填入表单：

```json
{"user":{"email":"demo@example.test"},"accessToken":"mock-session-local-only"}
```

| 卡密 | 场景 |
| --- | --- |
| `YUANXUAI-DEMO` | 处理中 → 订阅成功 |
| `YUANXUAI-FAIL` | 充值失败 |
| `YUANXUAI-CANCEL` | 取消 |
| `YUANXUAI-PENDING` | 持续处理 |
| `YUANXUAI-MANUAL` | 核验中 → 待人工核验 |
| `YUANXUAI-NO-CARD` | 暂无可用卡片 |

前端通过 `GET /api/runtime` 获取模式，只在 mock 模式显示标记；浏览器只访问本站。模拟订单仅存于内存，重启清空。`npm test -w @auto-pay/mock` 运行独立回环契约测试。