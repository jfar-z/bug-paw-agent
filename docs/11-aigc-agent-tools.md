# AIGC 接口发布为 Agent 工具

## 启用

1. 在 AIGC 工作台配置并验证 OpenAI、Grok 或 ComfyUI 接口。
2. 在接口列表编辑区或接口详情中勾选“发布为 Agent 工具”并保存，同时保持接口和渠道启用。
3. 在 Agent 的工具权限中分别授予所需的 AIGC 工具。新旧 Agent 均不自动获得这些权限。

发布开关在每次调用时读取，撤销后不能发现、提交或读取该接口的任务。为保留止损能力，仍允许具有取消权限的任务所有者取消自己的既有任务。通用文件、命令权限可能绕过业务工具边界，不能把工具白名单当作操作系统沙箱。

## 工具协议

| 工具 | 用途 | 权限 |
| --- | --- | --- |
| `aigc_list_interfaces` | 通过必填 `action` 分页查询接口或按真实 ID 获取参数定义 | 单独授权 |
| `aigc_create_task` | 校验参数并保存待运行任务，返回 `taskId` 和生效参数；不上传或运行 | 单独授权 |
| `aigc_run` | 传入 `taskIds`，整批异步启动 | 高风险，可能计费 |
| `aigc_run_and_wait` | 传入 `taskIds`，整批启动后等待全部终态，逐项交付文件 | 高风险，单独授权 |
| `aigc_get_task` | 查询所属任务，完成时交付工作区文件 | 单独授权 |
| `aigc_cancel_task` | 取消所属任务，返回上游确认状态 | 高风险，单独授权 |

接口列表每页 20 项，使用 `offset` / `nextOffset`；详情返回字段类型、必填性、默认值、枚举和数值范围。列表不返回渠道 URL、凭据或原始工作流。工具响应上限 64 KiB。

发现接口时必须传完整参数 `{ "action": "list", "interfaceId": null, "offset": 0 }`，后续分页只把 `offset` 替换为上次返回的 `nextOffset`。读取详情时必须传 `{ "action": "get", "interfaceId": "<列表返回的接口 ID>", "offset": null }`。禁止猜测接口 ID，也不使用空 `{}` 触发默认操作。

The interface editor stores an Agent-specific usage description. With `interfaceId`, the detail response includes `instructions`, `fields`, and `outputs`; each output defines `id`, `name`, `mediaType`, `description`, and `multiple`.

`aigc_create_task` 示例：

```json
{
  "interfaceId": "<接口 ID>",
  "requestKey": "cover-001",
  "parameters": [
    { "name": "prompt", "value": "一幅城市天际线插画" },
    { "name": "steps", "value": 20 }
  ]
}
```

每个参数项必须且只能提供 `name` 和 `value`。`value` 按接口字段类型使用原生 JSON 字符串、数字或布尔值；媒体字段使用工作区相对路径字符串。先读取接口定义，不猜测字段。可选字段缺失时使用已配置默认值；可选媒体字段也可显式传 `value: null`，等同于未提供。非媒体字段传 `null`、必填字段缺失或没有默认值时拒绝提交。枚举保留真实标量类型，数字枚举不能强制转为字符串。OpenAI“图片生成与编辑”接口省略参考图时调用文生图端点，提供参考图时调用图片编辑端点。OpenAI/Grok 图片编辑的 `image` 也接受有序路径数组，例如 `{ "name": "image", "value": ["attachments/first.png", "attachments/second.png"] }`；单张路径继续有效。OpenAI 最多 16 张，Grok 最多 5 张；其他媒体字段仍只接受单个路径。

创建只读校验工作区文件并保存内容指纹；运行时复核，文件变化必须重新创建任务。创建不复制到资产区或公开目录，不联系上游。所有接口的本地媒体均通过参数项的 `value` 指定当前 Agent 工作区相对路径，不接受任意资产 ID、宿主机路径、其他 Agent 文件或 ComfyUI input 文件名。服务端复用工作区路径、符号链接、大小和媒体类型校验，并按协议处理：OpenAI 保存到私有输入区后以 multipart 上传，ComfyUI 保存到私有输入区后上传到 ComfyUI input，Grok 自动复制到公开目录并提交稳定 URL。

Grok 本地媒体要求配置 `BUG_PAW_PUBLIC_ORIGIN`。该值必须是无需认证即可被上游访问的 HTTP(S) Origin，不得包含路径、凭据、查询参数或片段。未配置时，只有进程能读取到明确的 `BUG_PAW_BIND_ADDRESS` 才会回退到监听地址；通配地址不会被当作可访问地址。自动公开发生在显式运行的整批校验之后、提交执行之前；整批提交失败会清理本次副本，提交成功后保留在公开目录，可由用户统一管理。

## 任务归属与幂等

### 阻塞工具

创建工具返回 `status=prepared`，不会占用执行额度。核对生效参数后，将创建工具返回的真实任务 ID 传入运行工具：

```json
{"taskIds":["<任务 A 的 ID>","<任务 B 的 ID>"]}
```

单次要求 1～2 个不重复的 ID。服务端先校验整批归属、当前发布状态、配置版本和文件指纹；任一不通过都不会新启动任务。配置或文件变化必须重新创建。运行额度不足时仍接收提交，任务进入本地 FIFO 队列；批量提交按 taskIds 顺序入队，额度恢复后自动启动。

`aigc_run` 立即返回 `tasks`；`aigc_run_and_wait` 先提交全部任务，再等待整批终态。各任务独立执行，某个失败不取消其他任务，不自动重试。运行工具只要求自身授权；创建工具、发现、外部查询和取消仍单独授权。

等待工具使用 Pi `onUpdate` 报告每个任务的 ID 和进度，每 5 秒读取状态，不占外部查询限频窗口。返回 `tasks:[{taskId,status,files,error?}]`，顺序与输入 ID 一致，并包含整批 `waitStatus`：

- `completed`：所有任务均已结束，需逐项检查是否成功。失败进入工具错误事件，同时保留成功任务产物。
- `timed_out`：达到 30 分钟等待上限，保留已完成结果及活动状态，不取消后台任务。
- `interrupted`：中止聊天只结束等待；SDK 可能不展示最终返回，进度事件已包含任务 ID。

再次使用相同 `taskIds` 继续等待或返回已有结果；不再携带业务参数或 requestKey。重复运行任何已提交或终态 ID 都不会重新生成，失败和取消任务也不隐式重试。修改参数或明确重新生成时使用新 requestKey 创建新任务。Agent 两阶段任务不能从工作台直接重试。底层 30 分钟执行上限与等待期限独立。

### 状态与持久化

`prepared → queued → running → succeeded / failed / cancelled`。待运行也可直接取消，无上游调用。创建时固定最终生效参数和业务定义指纹，运行前再次核对完整 ComfyUI 原始定义、接口与渠道；运行中使用已核验快照。

待运行任务跨重启保留，绝不自动启动。进行中的任务重启后明确标记中断失败，不自动恢复可能计费的调用。整批状态一次原子持久化成功后，才启动任何上游请求；上游执行不保证事务性，部分失败保留其他结果。

### 归属规则

- Runtime 注入 `agentId` 和 `sessionId`，模型不能设置或覆盖。
- 新 Agent 任务在既有任务记录中保存 `agentOrigin`；历史手动任务没有该字段，只能在工作台管理。
- 查询、取消和产物交付按 Agent 隔离，允许同一 Agent 跨会话查询自己的任务。
- `requestKey` 以 Agent 和来源会话为作用域。同一次生成的重试必须使用同一个键：参数相同返回已有任务，参数不同返回冲突；不会自动重试失败、取消或中断的任务。
- 新键表示明确创建新任务。工具不会把不同键的两次生成意图合并，也不能保证上游网络服务具备事务性。
- 异常重启时，进行中的 Agent 任务标记为中断失败，不自动恢复提交。需人工核对上游再决定重试。
- 任务历史串行原子写入，避免并发更新丢失。工作台管理员保留管理全部任务的能力。

## 限额与交付

- 每个 Agent 默认最多 5 个活动任务，整个服务默认最多 20 个 Agent/MCP 活动任务；手动工作台任务不计入该限额。
- 每个 Agent 默认每小时最多运行 200 个任务，按实际启动时间计数，重复运行 ID 不增加计数；保留现有环境变量覆盖。
- 查询默认最小间隔 1 秒，正常返回建议间隔 `pollAfterMs=5000`。
- 待运行和本地排队任务不占执行配额，数量不会触发提交拒绝。
- 参数最多 100 项、128 KiB；单个工作区输入文件最多 100 MiB，单任务媒体输入合计最多 200 MiB。
- Agent 任务本地执行上限 30 分钟。超时不表示上游已经停止。
- 一次交付最多 20 个产物、合计 200 MiB；超过时在 AIGC 工作台查看，不把大文件塞入模型上下文。
- 产物先保存在 AIGC 资产区，查询成功任务时复制到所属 Agent 的 `attachments/`，记录已交付路径避免正常重复查询产生副本。
- Delivered `files` include `outputId` and `outputName`. ComfyUI mappings retain distinct identifiers, and multiple files from one mapping share that mapping identity.
- 对话使用普通 Markdown 链接交付工作区相对路径。Web 在用户点击后通过登录态 `/data` 文件接口解析和预览，不会返回凭证或未经授权的公共链接。

## 取消与后台行为

`status=cancelled` 表示 BugPaw 本地任务停止；只有 `upstreamCancellation=confirmed` 表示上游排队任务已确认移除。

ComfyUI 只尝试删除精确 `prompt_id` 对应的排队项，并复核队列和历史。已在运行、网络故障或状态不明时返回 `unknown`，绝不调用全局 `/interrupt`。OpenAI/Grok 请求中止通常无法保证上游取消，返回 `unknown`，可能继续产生算力消耗或费用。

后台任务不随聊天工具调用返回而终止。当前没有任务完成主动推送到聊天的功能，Agent 应返回任务 ID 和实际状态，不承诺自动通知，也不能反复提交任务来查询进度。

## 验证

回归覆盖工具根 Schema、默认权限、发布撤销、跨 Agent/历史任务隔离、参数校验、幂等与并发、查询限频、工作区媒体边界、产物交付、上游取消语义、迟到成功响应以及重启中断。按项目规定的 Node Docker 环境执行 `npm run verify`。

### 本地排队与恢复

手动、Agent、MCP 任务共用 AIGC FIFO 队列。现有额度统一限制实际运行数：全局默认 20、每调用方默认 5、每调用方每小时默认启动 200；手动请求视为同一调用方，Agent 与 MCP 分别按身份分组。队首额度不足时后续任务不会插队，因此可能暂时存在空闲并发槽位。小时额度恢复会自动唤醒，排队不计入 30 分钟执行超时。

提交序号持久化，重启后恢复未启动任务；旧版无提交序号的活动任务或已开始执行的任务标记中断失败，不自动重试。取消本地排队任务无需请求上游，停止状态为 confirmed。页面及任务查询的 queueReason 展示本地等待原因。参数校验、发布及授权校验、查询限频仍保留。
