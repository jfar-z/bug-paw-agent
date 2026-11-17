# API 约定

- 健康检查固定为 `/healthz`；业务 API 固定为 `/api/v1/*`，旧 `/api/*` 不兼容回退。
- JSON 错误固定为 `{ error: { code, message, requestId, details? } }`。`code` 必须来自共享 `ApiErrorCode`，客户端只按 `code` 分支，不比较中文文案；Route 不得直接拼装错误对象。
- `requestId` 同时写入 `X-Request-Id`。未知异常返回 `INTERNAL_ERROR`，不输出堆栈、路径、凭据或原始异常。
- 写操作使用明确的资源语义和乐观锁 revision；冲突返回 `VERSION_CONFLICT`。
- SSE 事件必须带单调事件 ID；重连使用游标，游标缺口发送 `projection_required` 并由客户端重新读取 Projection。Runtime 换代会结束旧连接以触发自动重连，慢客户端只断开自身。
- 请求体、文件数量/大小、分页、扫描和队列必须引用 `SYSTEM_LIMITS`。

新增或修改 API 时，应同时更新 Shared Schema、服务端契约测试、Web Client 测试和本文档；不得在页面组件中新增裸 `/api` 路径。

## AIGC 任务诊断

`GET /api/v1/aigc/tasks/:id` 沿用登录认证，在任务详情中可选返回 `diagnostics`；列表、Agent 与 MCP 摘要不附带此正文。`request` 为实际提交的 `{ method, endpoint, body }`，包含合并默认值后的 OpenAI/Grok 业务入参；endpoint 为相对渠道端点，不暴露渠道地址。JSON body 保持对象，multipart body 为有序 `{ name, value }[]`，文件 value 仅含 `{ name, mediaType, size }`，二进制内容不复制。

`response` 为最近一次生成或轮询接口的 `{ endpoint, status, body, truncated }`。body 为脱敏文本（JSON 美化），最多 65536 字符，超限时 truncated 为 true；HTTP 200 业务失败也保留回参。认证字段、渠道密钥、签名 URL 参数、路径、堆栈和 base64 产物不公开。网络失败可能只有 request；尚未发送及历史任务可能没有 diagnostics，不得推算或伪造请求。重试清除上一轮诊断。沿用现有任务 Repository 的原子持久化与重启恢复规则，无数据库迁移。
