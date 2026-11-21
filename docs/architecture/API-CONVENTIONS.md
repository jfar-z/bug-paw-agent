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

## AIGC 工作台批量创作与再次运行

登录后的工作台可向 `POST /api/v1/aigc/tasks/batch` 提交 `{interfaceId, inputs, count, requestKey, confirmPublicTransfer?}`。批次数量 `count` 为 1～10 的整数；`inputs.count` 仍是 Grok 单次生成数量。请求键为 1～80 位字母、数字、下划线或连字符。成功返回 HTTP 202 和按入队顺序排列的 `{taskIds: string[]}`。每个成员按手动任务身份独立排队、取消和保存产物。

媒体沿用创作表单的上传资产、公共文件、媒体库及 ComfyUI input 引用。整批共用一次媒体准备。需要公网确认时返回 `VALIDATION_FAILED` 和 `details.requiresPublicTransfer`，确认后使用原请求键重发。已受理请求按工作台手动身份、请求键及原始接口、次数、输入指纹恢复。数组顺序参与指纹；同键不同内容返回 `CONFLICT`。登记的 ID 可跨重启恢复，删除过的成员不会重新生成。

登录后读取 `GET /api/v1/aigc/tasks/:id/rerun-draft` 返回 `{interfaceId, interfaceAvailable, inputs, issues: [{field?, message}]}`。表单显示服务端返回的可用输入和逐项提示，每次打开把批次数量设为 1。原接口不可用时 `interfaceAvailable` 为 false。草稿仅使用保存的业务输入和当前字段定义。私有工作区路径和 MCP 上传文件需要重新选择；媒体库引用按工作台当前权限重新核验。确认运行仍走批量创作入口，原任务重试继续使用 `POST /api/v1/aigc/tasks/:id/retry`。

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
| `/:libraryId/files/delete` | POST `{files:[{id,revision}]}` | 200，按输入顺序返回 `{results:[{id,status,code?,message?}]}` |
| `/:libraryId/files/from-result` | POST `{source:"aigc"|"workflow",taskId,assetId,name?}`，工作流使用运行 ID | 201 独立入库的文件对象 |
| `/:libraryId/files/:fileId` | GET 或 PATCH `{name,revision}` | 文件对象 |
| `/:libraryId/files/:fileId` | DELETE `{revision}` | 204 |
| `/:libraryId/files/:fileId/content`、`/thumbnail`（同一文件下） | GET、HEAD，GET 支持单一 bytes Range | 原件或 JPEG 封面；音频仅有原件 |

名称去首尾空白、规范化 NFC，文件名按小写完整名称在库内判重。上传示例为 `formData.append("file", selectedFile, editedStem + extension)`。有效扩展名为 jpg、jpeg、png、mp4、mp3。单文件最大 50 MiB，图片最大 6400 万像素，音视频需在 60 秒内解码。服务同时接收最多 3 个上传，最多 500 个库和每库 5000 个文件。

库对象始终含字符串 `note`，无备注时为 `""`。编辑按 ID 一次提交，例如 `{"name":"素材","note":"第一行\n第二行","revision":6}`。仅修改备注时也提交当前名称。省略 note 保留旧值，传空白清空。备注去除首尾空白，保留内部换行，按 Unicode 码点最多 500 个。名称和备注全部校验通过后同时保存，值有变化才递增一次库版本。字段错误返回 400 VALIDATION_FAILED，details.field 为 name 或 note。

删除确认取自最新库详情，例如 `{"name":"素材","fileCount":3,"revision":6}`。任一文件添加、删除、有效改名或库名、备注有效变更均更新库版本。版本过期返回 409 VERSION_CONFLICT，调用方刷新详情、清除原确认并再次提示。名称或数量不符返回 400 VALIDATION_FAILED。并发重名返回 409 MEDIA_NAME_CONFLICT，客户端保留输入。文件改名与删除使用文件自身的 revision。

未登录返回 401 AUTH_REQUIRED，资源缺失或归属错误返回 404 NOT_FOUND。格式不支持为 415 MEDIA_FORMAT_UNSUPPORTED，无法解码为 422 MEDIA_FILE_INVALID，大小或数量超限为 413 MEDIA_UPLOAD_LIMIT，上传繁忙为 429 MEDIA_UPLOAD_BUSY。处理器缺失及正文存取故障使用 500 MEDIA_PROCESSING_FAILED 或 MEDIA_STORAGE_FAILED。不可满足的 Range 使用标准 416 和 Content-Range。其他错误遵循统一 API 错误文档。

工作台提交单次 AIGC 或 DAG 运行时，媒体字段可传 `media-library://<libraryId>/<fileId>` 字符串，数组按原顺序传递。经过公网字段时请求体顶层须传 `confirmPublicTransfer: true`。需要确认时返回 400 VALIDATION_FAILED，`details.requiresPublicTransfer` 为 true，`details.field` 指出参数。返回 202 时执行已接管副本。DAG 请求继续使用原 requestKey。

Agent 的创建和带 revision 的 PATCH 请求可携带 `mediaLibraryGrants: [{libraryId,read,upload,publicTransfer,delete?}]`。这是整组替换，缺省沿用已有设置，传空数组撤销全部。publicTransfer 须同时有 read。媒体工具名为 `media_library`，按当前 allowlist 和库授权执行。默认没有库授权。Agent 工具的媒体参数同样接受上述引用，待运行任务在提交时复核。授权仅适用于当前 Agent 的这次工具调用。

批量删除要求一次提交同一库内 1 至 5000 个不同文件的 ID 和正整数版本。参数整体不合法时返回 400。每项事务单独校验版本并提交。结果中 `deleted` 表示删除及回收成功，`missing` 表示该 ID 已不在指定库，`failed` 表示删除失败（包括 VERSION_CONFLICT），`cleanup_failed` 表示记录已删除但受管目录回收失败，服务重启时重新清理。重试须按最新名称和版本再次确认。

Agent 工具 `media_library_delete({libraryId,fileIds})` 需要独立工具白名单及指定库的 `delete: true`，缺省关闭。工具读取指定目标的确认快照，在当前会话等待登录用户决定。工作台以媒体库根路径为前缀，GET `/confirmations/:agentId/:sessionId` 获得 `{confirmations: MediaDeletePrompt[]}`。共享类型定义库名、文件名、标识、版本和毫秒时间戳 expiresAt。用户查看完整清单与永久删除提示后，POST `/confirmations/:agentId/:sessionId/:id`，正文为 `{"confirm":true}` 或 `{"confirm":false}`。204 表示决定已接收，实际删除结果由工具返回。停止运行、服务重启或五分钟超时使确认失效，跨会话及重复决定返回 404。执行前重新校验授权，按用户看到的版本逐项执行。

## 手动批量运行 DAG

已登录工作台调用 `POST /api/v1/workflows/:id/run-batch`，例如 `{"inputs":{"prompt":"测试"},"count":3,"requestKey":"batch-123","confirmPublicTransfer":true}`。次数必须是 1 至 10 的整数。文件和公网传输确认沿用单次运行契约。HTTP 202 返回 `{"runIds":["运行 ID 1","运行 ID 2","运行 ID 3"]}`，数组包含整批受理的 ID，按 FIFO 入队顺序排列。相同 requestKey、工作流、输入及次数的重试返回同一数组，修改其中业务参数并复用键返回 400 CONFLICT。校验失败返回 400 VALIDATION_FAILED，整批不入队。

通过 `GET /api/v1/workflow-runs/:id` 查询成员的 status、queueReason、startedAt 和 queueOrder。队首启动前取消时可观察下一成员，实际启动后锁定该运行 ID。取消操作只作用于指定 ID。已有单次运行接口和 Agent 工具继续使用原契约。
