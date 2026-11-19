# 数据所有权

| 数据 | 唯一事实来源 | 说明 |
|---|---|---|
| 用户、Web Session、Agent Profile、Session 归属、任务与运行历史、知识元数据、配置历史索引 | `app/bugpaw.sqlite3` | WAL、外键开启、Migration 管理 |
| Provider、凭据、Pi Settings | `pi/models.json`、`pi/auth.json`、`pi/settings.json` | 保持 Pi 原生格式；事务式原子替换 |
| 对话消息 | Pi Session JSONL | SQLite 不复制消息正文 |
| Agent Prompt、头像、Workspace、知识原文/解析文本 | 受管文件目录 | SQLite 只保存引用和元数据 |
| 知识全文索引 | LanceDB | 可由原文和元数据重建 |
| Runtime Event Journal | 内存 | 有界窗口；检查点只保存恢复投影，不复制完整事件 |

每个 Agent（包括 `default`）的 Pi Session 固定保存到 `pi/sessions/<agentId>/`。本轮部署会按约定清空旧数据，因此不保留根目录 Session 的兼容读取；该隔离保证删除一个 Agent 时不会移动其他 Agent 的会话。

Agent 与 Session 使用保护性外键。未明确选择“同时删除关联 Sessions”时，有 Session 的 Agent 删除请求返回 `AGENT_HAS_SESSIONS`；确认后 Session 元数据和 Agent 在同一 SQLite 事务中删除，随后才提交已暂存的 Session 文件。

删除单个 Session 时，Runtime 先阻止该 Session 的新修改并把 JSONL 原子移动到同卷暂存名；随后 SQLite 在一个事务内删除 Session 元数据及其绑定定时任务。数据库失败时恢复 JSONL，数据库提交后再清理暂存文件。清理失败只记录结构化后台错误，不把已经提交的删除伪装成可重试失败。

禁止恢复 `config.json`、`agent-order.json`、`sessions.json`、`session-metadata.json` 等旧应用 JSON Store。敏感凭据不得进入 SQLite、接口、日志、测试或文档。

修改持久化结构必须新增只前进 Migration，覆盖事务回滚、外键和关闭重开测试，并更新本文件。

Migration 009 增加 media_libraries 和 media_files。SQLite 负责名称、版本、归属与唯一性，原件和 JPEG 缩略图由 app/media-library/<文件 UUID>/ 独占。上传先完整接收、解码并写入独立目录，再于一个事务中插入元数据并更新库版本。整库删除在写事务内验证库名、版本和数量，级联删除全部文件记录后清理受管目录。清理错误通过 API 返回，旧链接随事务提交失效。服务在实例锁内启动时按 UUID 目录和数据库重新核对并回收中断操作的遗留文件。已有数据无需转换。旧代码无法读取媒体库，回滚代码须保留数据库与媒体目录，迁移没有降级脚本。
