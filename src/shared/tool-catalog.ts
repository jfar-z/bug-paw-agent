/**
 * Agent 可授权工具的稳定目录。
 *
 * 内置和系统工具在前后端共用，扩展工具由资源加载器动态补充。
 */
export interface ToolCatalogItem {
  name: string;
  description: string;
  source: "builtin" | "system" | "capability";
  highRisk: boolean;
}

/** 内置文件与命令工具。 */
export const BUILTIN_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "read", description: "读取工作目录中的文件", source: "builtin", highRisk: false },
  { name: "bash", description: "在工作目录中执行命令", source: "builtin", highRisk: true },
  { name: "edit", description: "编辑已有文件", source: "builtin", highRisk: true },
  { name: "write", description: "创建或覆盖文件", source: "builtin", highRisk: true },
  { name: "grep", description: "按内容搜索文件", source: "builtin", highRisk: false },
  { name: "find", description: "按路径查找文件", source: "builtin", highRisk: false },
  { name: "ls", description: "列出目录内容", source: "builtin", highRisk: false },
];

/** Web 系统注入、但同样必须获得 Agent 授权的工具。 */
export const SYSTEM_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "ask_user", description: "向用户提交结构化问题并等待回答", source: "system", highRisk: false },
  { name: "session_list", description: "列出当前 Agent 的历史会话摘要", source: "system", highRisk: false },
  { name: "session_search", description: "搜索当前 Agent 的历史会话文本", source: "system", highRisk: false },
  { name: "session_read", description: "读取当前 Agent 的历史会话文本上下文", source: "system", highRisk: false },
  { name: "knowledge_search", description: "检索当前 Agent 可访问的知识库", source: "system", highRisk: false },
  { name: "knowledge_read", description: "读取知识库资料或命中位置上下文", source: "system", highRisk: false },
  { name: "knowledge_manage", description: "管理当前 Agent 的知识库与资料", source: "system", highRisk: true },
  { name: "scheduled_tasks", description: "创建、修改和执行定时任务", source: "system", highRisk: true },
];

/** 启动时需要从存量 Agent 权限中精确移除的废弃工具。 */
export const RETIRED_AGENT_TOOL_NAMES = ["edit_own_prompts"] as const;

/** 由能力扩展模块提供、可按全局开关停用的工具。 */
export const CAPABILITY_TOOL_CATALOG: ToolCatalogItem[] = [
  { name: "media_library", description: "按授权浏览、查看或上传媒体库文件，返回稳定的执行引用", source: "capability", highRisk: true },
  { name: "workflow_list", description: "查询已发布工作流及输入输出参数", source: "capability", highRisk: false },
  { name: "workflow_get_parameters", description: "仅查询工作流出入参，不包含内部节点与脚本", source: "capability", highRisk: false },
  { name: "workflow_get_definition", description: "查询工作流节点与连线定义", source: "capability", highRisk: false },
  { name: "workflow_create_task", description: "校验并创建待运行工作流任务，不运行节点", source: "capability", highRisk: false },
  { name: "workflow_run", description: "按任务 ID 批量运行工作流，可能计费", source: "capability", highRisk: true },
  { name: "workflow_run_and_wait", description: "按任务 ID 批量运行并等待工作流，可能计费", source: "capability", highRisk: true },
  { name: "workflow_get_task", description: "查询所属工作流任务并交付文件", source: "capability", highRisk: false },
  { name: "workflow_cancel_task", description: "取消所属工作流任务", source: "capability", highRisk: true },

  { name: "aigc_list_interfaces", description: "按明确操作查询已发布的 AIGC 接口及参数", source: "capability", highRisk: false },
  { name: "aigc_create_task", description: "校验并创建待运行 AIGC 任务，不触发生成", source: "capability", highRisk: false },
  { name: "aigc_run", description: "按任务 ID 批量运行 AIGC 任务，可能计费", source: "capability", highRisk: true },
  { name: "aigc_run_and_wait", description: "按任务 ID 批量运行 AIGC 并等待产物，可能计费", source: "capability", highRisk: true },
  { name: "aigc_get_task", description: "查询所属 AIGC 任务并交付产物", source: "capability", highRisk: false },
  { name: "aigc_cancel_task", description: "取消所属 AIGC 任务", source: "capability", highRisk: true },
  { name: "web_search", description: "搜索互联网并返回可引用来源", source: "capability", highRisk: false },
  { name: "web_read", description: "按段落读取或查找公开网页正文", source: "capability", highRisk: false },
  { name: "web_research", description: "搜索并读取正文取证，需同时授权联网搜索与网页读取", source: "capability", highRisk: false },
  { name: "pdf_read", description: "按页读取、查找和查看公开 PDF", source: "capability", highRisk: false },
  { name: "browser_open", description: "打开公网 HTTPS 或工作区静态 HTML", source: "capability", highRisk: false },
  { name: "browser_snapshot", description: "读取浏览器页面及稳定元素引用", source: "capability", highRisk: false },
  { name: "browser_click", description: "点击浏览器中的普通交互元素", source: "capability", highRisk: false },
  { name: "browser_scroll", description: "按受控方向和距离滚动页面", source: "capability", highRisk: false },
  { name: "browser_screenshot", description: "截取页面并保存到工作区", source: "capability", highRisk: false },
  { name: "browser_download", description: "下载允许类型的网页文件", source: "capability", highRisk: false },
  { name: "browser_input", description: "在受信任 UI 中输入普通文本", source: "capability", highRisk: true },
  { name: "browser_submit", description: "在受信任 UI 中提交普通表单", source: "capability", highRisk: true },
  { name: "browser_upload", description: "向受信任 UI 上传工作区文件", source: "capability", highRisk: true },
];

/** 新建 Agent 的默认权限，保持现有开箱即用的能力。 */
export const DEFAULT_AGENT_TOOL_NAMES = [...BUILTIN_TOOL_CATALOG, ...SYSTEM_TOOL_CATALOG, ...CAPABILITY_TOOL_CATALOG]
  .filter(({ name }) => !["media_library", "browser_input", "browser_submit", "browser_upload"].includes(name))
  .filter(({ name }) => !name.startsWith("aigc_") && !name.startsWith("workflow_"))
  .map(({ name }) => name);

/** 历史 Agent 升级时需要补齐的系统工具权限。 */
export const SYSTEM_TOOL_NAMES = SYSTEM_TOOL_CATALOG.map(({ name }) => name);

/** 每次启动强制补齐的历史系统工具；ask_user 只由 Migration 一次性授予。 */
export const STARTUP_ENFORCED_SYSTEM_TOOL_NAMES = SYSTEM_TOOL_NAMES
  .filter((name) => name !== "ask_user");
