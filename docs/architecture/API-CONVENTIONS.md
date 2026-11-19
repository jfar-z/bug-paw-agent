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

## 媒体库

工作台登录会话访问 `/api/v1/media-libraries`。库和文件使用稳定 UUID，元数据结构见 `src/shared/media-library-contracts.ts`。响应带 `Cache-Control: private, no-store`。

| 相对路径 | 方法与参数 | 成功响应 |
| --- | --- | --- |
| 根路径 | GET 或 POST `{name}` | `{libraries: MediaLibrary[]}` 或 201 库对象 |
| `/:libraryId` | GET 或 PATCH `{name,revision,note?}` | 库对象 |
| `/:libraryId` | DELETE `{name,fileCount,revision}` | 204 |
| `/:libraryId/name-check` | GET 查询 name，可用 excludeFileId 排除当前文件 | `{available:boolean}` |
| `/:libraryId/files` | GET，可选 category 为 image、video、audio | `{files: MediaFile[]}`，新上传的在前 |
| `/:libraryId/files` | POST 一个 multipart 文件字段 file，filename 为拟保存的完整名称 | 201 文件对象 |
| `/:libraryId/files/:fileId` | GET 或 PATCH `{name,revision}` | 文件对象 |
| `/:libraryId/files/:fileId` | DELETE `{revision}` | 204 |
| `/:libraryId/files/:fileId/content`、`/thumbnail`（同一文件下） | GET、HEAD，GET 支持单一 bytes Range | 原件或 JPEG 封面；音频仅有原件 |

名称去首尾空白、规范化 NFC，文件名按小写完整名称在库内判重。上传示例为 `formData.append("file", selectedFile, editedStem + extension)`。有效扩展名为 jpg、jpeg、png、mp4、mp3。单文件最大 50 MiB，图片最大 6400 万像素，音视频需在 60 秒内解码。服务同时接收最多 3 个上传，最多 500 个库和每库 5000 个文件。

库对象始终含字符串 `note`，无备注时为 `""`。编辑按 ID 一次提交，例如 `{"name":"素材","note":"第一行\n第二行","revision":6}`。仅修改备注时也提交当前名称。省略 note 保留旧值，传空白清空。备注去除首尾空白，保留内部换行，按 Unicode 码点最多 500 个。名称和备注全部校验通过后同时保存，值有变化才递增一次库版本。字段错误返回 400 VALIDATION_FAILED，details.field 为 name 或 note。

删除确认取自最新库详情，例如 `{"name":"素材","fileCount":3,"revision":6}`。任一文件添加、删除、有效改名或库名、备注有效变更均更新库版本。版本过期返回 409 VERSION_CONFLICT，调用方刷新详情、清除原确认并再次提示。名称或数量不符返回 400 VALIDATION_FAILED。并发重名返回 409 MEDIA_NAME_CONFLICT，客户端保留输入。文件改名与删除使用文件自身的 revision。

未登录返回 401 AUTH_REQUIRED，资源缺失或归属错误返回 404 NOT_FOUND。格式不支持为 415 MEDIA_FORMAT_UNSUPPORTED，无法解码为 422 MEDIA_FILE_INVALID，大小或数量超限为 413 MEDIA_UPLOAD_LIMIT，上传繁忙为 429 MEDIA_UPLOAD_BUSY。处理器缺失及正文存取故障使用 500 MEDIA_PROCESSING_FAILED 或 MEDIA_STORAGE_FAILED。不可满足的 Range 使用标准 416 和 Content-Range。其他错误遵循统一 API 错误文档。
