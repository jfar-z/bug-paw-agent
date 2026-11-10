import type { TaskPreparation } from "./task-preparation-contracts";
import type { CredentialStatus } from "./configuration-contracts";

/** 当前支持的 AIGC 渠道协议。 */
export const AIGC_CHANNEL_TYPES = ["openai", "grok", "comfyui"] as const;
export type AigcChannelType = typeof AIGC_CHANNEL_TYPES[number];

/** AIGC 渠道创建时可选用的官方模板。 */
export interface AigcChannelTemplate {
  id: string;
  name: string;
  type: AigcChannelType;
  defaultBaseUrl: string;
  credentialOptional: boolean;
}

/** 单条渠道的非敏感配置。 */
export interface AigcChannelConfig {
  /** 创建后不可修改的渠道标识。 */
  id: string;
  /** 配置中心展示的渠道名称。 */
  name: string;
  /** 渠道协议类型。 */
  type: AigcChannelType;
  /** 去除尾部斜杠后的服务基础地址。 */
  baseUrl: string;
  /** 是否允许接口引用该渠道。 */
  enabled: boolean;
  /** 上游单次请求超时毫秒数；ComfyUI 未设置时不限制。 */
  timeoutMs?: number;
}

/** 返回浏览器的渠道摘要，不包含凭证明文。 */
export interface AigcChannelSummary extends AigcChannelConfig {
  /** 当前渠道是否已保存 API Key。 */
  hasApiKey: boolean;
}

/** 工作流执行页可见的渠道状态，不包含可能指向内网的服务地址。 */
export type AigcRuntimeChannelSummary = Pick<AigcChannelSummary, "id" | "name" | "type" | "enabled" | "hasApiKey">;

/** 浏览器提交的渠道配置字段。 */
export interface AigcChannelInput {
  name: string;
  type: AigcChannelType;
  baseUrl: string;
  enabled: boolean;
  timeoutMs?: number;
}

/** 对渠道凭证执行的明确操作。 */
export type AigcCredentialMutation =
  | { action: "keep" }
  | { action: "replace"; apiKey: string }
  | { action: "remove" };

/** 原子创建渠道与可选凭证的输入。 */
export interface AigcCreateChannelInput {
  configRevision: string;
  credentialRevision: string;
  channel: AigcChannelConfig;
  apiKey?: string;
}

/** 原子编辑渠道及其凭证的输入。 */
export interface AigcUpdateChannelInput {
  configRevision: string;
  credentialRevision: string;
  channel: AigcChannelConfig;
  credential: AigcCredentialMutation;
}

/** 配置中心读取的 AIGC 渠道设置文档。 */
export interface AigcSettingsDocument {
  revision: string;
  channels: AigcChannelSummary[];
  channelTemplates: AigcChannelTemplate[];
  credentials: CredentialStatus[];
  credentialRevision: string;
}

/** 工作流入参可选的参数类型。 */
export type AigcWorkflowInputType = "bool" | "int" | "double" | "string" | "enum" | "image" | "video" | "audio";

/** ComfyUI 枚举字段允许保留的原始标量值。 */
export type AigcWorkflowEnumValue = string | number | boolean;

/** 从 ComfyUI object_info 解析出的字段约束。 */
export interface ComfyUiFieldMetadata {
  comfyType: string;
  valueType?: AigcWorkflowInputType;
  required?: boolean;
  defaultValue?: AigcWorkflowEnumValue;
  min?: number;
  max?: number;
  step?: number;
  round?: number;
  enumOptions?: AigcWorkflowEnumValue[];
  tooltip?: string;
  multiline?: boolean;
  placeholder?: string;
}

/** UI 工作流控件值转换为 API 输入时使用的有序字段描述。 */
export interface ComfyUiWidgetInputMetadata {
  /** API Prompt 中的输入字段名。 */
  name: string;
  /** 动态控件按当前选项展开的子字段名。 */
  dynamicOptions?: Record<string, string[]>;
}

/** 节点实例字段的最终元数据来源。 */
export type ComfyUiResolvedFieldMetadataSource = "direct" | "inferred" | "workflow";

/** 参与动态字段推导的下游目标。 */
export interface ComfyUiFieldMetadataReference {
  nodeId: string;
  field: string;
}

/** 合并节点定义、工作流结构与连接约束后的实例级字段元数据。 */
export interface ComfyUiResolvedFieldMetadata extends ComfyUiFieldMetadata {
  source: ComfyUiResolvedFieldMetadataSource;
  inferredFrom?: ComfyUiFieldMetadataReference[];
  conflict?: string;
}

/** 按节点 ID 和字段路径索引的实例级字段元数据。 */
export type ComfyUiResolvedFieldMetadataMap = Record<string, Record<string, ComfyUiResolvedFieldMetadata>>;

/** 单类 ComfyUI 节点的展示信息和输入字段约束。 */
export interface ComfyUiNodeTypeMetadata {
  displayName?: string;
  description?: string;
  category?: string;
  fields: Record<string, ComfyUiFieldMetadata>;
  /** ComfyUI 前端序列化 widgets_values 时使用的字段顺序。 */
  widgetInputs?: ComfyUiWidgetInputMetadata[];
}

/** 按 ComfyUI class_type 索引的节点元数据。 */
export type ComfyUiNodeMetadata = Record<string, ComfyUiNodeTypeMetadata>;

/** 一次节点元数据同步的结果摘要。 */
export interface ComfyUiNodeMetadataSyncResult {
  metadata: ComfyUiNodeMetadata;
  syncedNodeClasses: string[];
  missingNodeClasses: string[];
  syncedAt: string;
}

/** 入参有值时保留的 ComfyUI 条件节点组。 */
export interface AigcWorkflowInputActivation {
  when: "provided";
  /** 未提供该入参时，从 API Prompt 中删除的完整节点组。 */
  nodeIds: string[];
}

/** ComfyUI 工作流中的单个输入字段映射。 */
export interface AigcWorkflowInputMapping {
  id: string;
  /** 展示给调用方的稳定参数名。 */
  name: string;
  nodeId: string;
  /** 目标节点的输入或 UI widget 字段路径，例如 inputs.text。 */
  field: string;
  type: AigcWorkflowInputType;
  required: boolean;
  /** enum 类型可选的候选值。 */
  enumOptions?: AigcWorkflowEnumValue[];
  defaultValue?: string | number | boolean;
  description?: string;
  /** 可选参数未提供时，裁剪与该参数绑定的条件分支。 */
  activation?: AigcWorkflowInputActivation;
}

/** 由多个同类可选映射组成的参考素材输入组。 */
export interface AigcWorkflowInputGroup {
  id: string;
  label: string;
  type: "image" | "video" | "audio";
  /** 成员顺序同时决定运行时素材槽位顺序。 */
  mappingIds: string[];
  /** 用户指定的共享汇总节点。 */
  boundaryNodeId: string;
  /** 用户选择的汇总接口系列，例如 inputs.references。 */
  targetFieldPrefix: string;
}

/** ComfyUI 工作流输出字段映射。 */
export interface AigcWorkflowOutputMapping {
  id: string;
  name: string;
  nodeId: string;
  /** 从该节点读取输出时使用的字段路径。 */
  field: string;
  mediaType: "image" | "video" | "audio" | "json" | "text";
  description?: string;
}

/** 解析后的 ComfyUI 节点。 */
export interface ComfyUiNode {
  id: string;
  type: string;
  title?: string;
  /** 可用于字段映射的节点字段列表。 */
  fields: ComfyUiField[];
}

/** 解析后的 ComfyUI 节点字段。 */
export interface ComfyUiField {
  name: string;
  /** ComfyUI 节点为字段配置的展示别名，不影响真实映射路径。 */
  label?: string;
  kind: "input" | "output" | "widget" | "unknown";
  /** 基于 ComfyUI 节点字段内容推断出的值类型。 */
  valueType?: AigcWorkflowInputType;
}

/** 解析后的 ComfyUI 节点连线。 */
export interface ComfyUiEdge {
  id: string;
  sourceNodeId: string;
  sourceField: string;
  targetNodeId: string;
  targetField: string;
}

/** 工作流列表项。 */
export interface AigcWorkflowSummary {
  id: string;
  name: string;
  fileName: string;
  originalHash: string;
  nodeCount: number;
  edgeCount: number;
  inputCount: number;
  outputCount: number;
  createdAt: string;
  updatedAt: string;
}

/** 工作流详情。 */
export interface AigcWorkflowDetail {
  id: string;
  name: string;
  fileName: string;
  originalHash: string;
  nodes: ComfyUiNode[];
  edges: ComfyUiEdge[];
  inputMappings: AigcWorkflowInputMapping[];
  inputGroups?: AigcWorkflowInputGroup[];
  outputMappings: AigcWorkflowOutputMapping[];
  /** 最近成功同步并保存的 ComfyUI 节点定义。 */
  nodeMetadata?: ComfyUiNodeMetadata;
  /** 按节点实例解析出的最终字段约束，不作为持久化真值。 */
  resolvedFieldMetadata?: ComfyUiResolvedFieldMetadataMap;
  nodeMetadataSyncedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** 工作流列表文档。 */
export interface AigcWorkflowDocument {
  revision: string;
  workflows: AigcWorkflowSummary[];
}

/** 导入工作流时的浏览器输入。 */
export interface AigcWorkflowCreateInput {
  name: string;
  fileName: string;
  /** 完整的 ComfyUI 工作流 JSON，由服务端解析但不会执行脚本。 */
  workflowJson: unknown;
  inputMappings: AigcWorkflowInputMapping[];
  inputGroups?: AigcWorkflowInputGroup[];
  outputMappings: AigcWorkflowOutputMapping[];
}

/** 更新工作流映射时的浏览器输入。 */
export interface AigcWorkflowUpdateInput {
  name: string;
  inputMappings: AigcWorkflowInputMapping[];
  inputGroups?: AigcWorkflowInputGroup[];
  outputMappings: AigcWorkflowOutputMapping[];
}

/** 替换工作流原始内容时的浏览器输入。 */
export interface AigcWorkflowReplaceInput {
  fileName: string;
  /** 新的完整 ComfyUI 工作流 JSON，现有映射必须与其保持兼容。 */
  workflowJson: unknown;
  /** 用户确认预检查结果后回传的摘要；存在映射损失时必须提供。 */
  confirmationToken?: string;
}

/** 替换时无法保留的一项映射或参数组，仅包含定位和影响说明。 */
export interface AigcWorkflowReplacementImpact {
  kind: "input" | "output" | "input-group";
  id: string;
  name: string;
  nodeId: string;
  field: string;
  reason: string;
}

/** 只读替换检查结果，摘要绑定原配置、新文件和集合版本。 */
export interface AigcWorkflowReplacementPreview {
  revision: string;
  confirmationToken: string;
  removedMappings: AigcWorkflowReplacementImpact[];
}

/** 工作流详情文档。 */
export interface AigcWorkflowDetailDocument {
  revision: string;
  workflow: AigcWorkflowDetail;
}

/** 接口使用的协议类型。 */
export type AigcInterfaceProtocol = AigcChannelType;

/** 接口可暴露给用户的能力类型。 */
export type AigcInterfaceCapability = "text-to-image" | "image-edit" | "text-to-video" | "image-to-video" | "video-edit" | "video-extend";

/** OpenAI 自定义参数支持的标量类型。 */
export type AigcOpenAiParameterType = "string" | "integer" | "number" | "boolean";

/** OpenAI 自定义参数支持的标量值。 */
export type AigcOpenAiParameterValue = string | number | boolean;

/** OpenAI 协议的一个可配置请求参数。 */
export interface AigcOpenAiParameterDefinition {
  /** 发送给上游接口的真实字段名。 */
  name: string;
  type: AigcOpenAiParameterType;
  enumValues?: AigcOpenAiParameterValue[];
  defaultValue?: AigcOpenAiParameterValue;
  description: string;
}

/** OpenAI 协议接口参数。 */
export interface AigcOpenAiInterfaceConfig {
  model: string;
  parameters?: AigcOpenAiParameterDefinition[];
  /** 兼容旧版固定尺寸配置，读取后会转换为 parameters。 */
  size?: string;
  /** 兼容旧版固定质量配置，读取后会转换为 parameters。 */
  quality?: string;
  /** 兼容旧版响应格式配置，读取后会转换为 parameters。 */
  responseFormat?: string;
}

/** Grok 协议接口参数。 */
export interface AigcGrokInterfaceConfig {
  model: string;
  /** 可选输出尺寸，使用 WIDTHxHEIGHT 格式。 */
  size?: string;
  /** 可选视频时长，单位为秒。 */
  duration?: number;
}

/** ComfyUI 协议接口参数。 */
export interface AigcComfyUiInterfaceConfig {
  workflowId: string;
}

/** 单个 AIGC 接口的非敏感配置。 */
export interface AigcInterfaceRecord {
  id: string;
  name: string;
  description: string;
  /** 面向 Agent 的接口用途、调用约束与结果解释。 */
  toolDescription?: string;
  protocol: AigcInterfaceProtocol;
  capability: AigcInterfaceCapability;
  channelId: string;
  enabled: boolean;
  /** 允许已授权的 Agent 发现并调用此接口。 */
  toolPublishEnabled: boolean;
  /** 允许持有专用令牌的外部 MCP 客户端调用。 */
  mcpPublishEnabled?: boolean;
  config: AigcOpenAiInterfaceConfig | AigcGrokInterfaceConfig | AigcComfyUiInterfaceConfig;
  createdAt: string;
  updatedAt: string;
}

/** 接口列表文档。 */
export interface AigcInterfaceDocument {
  revision: string;
  interfaces: AigcInterfaceRecord[];
}

/** 接口创建或更新的浏览器输入。 */
export interface AigcInterfaceInput {
  name: string;
  description: string;
  /** 面向 Agent 的接口用途、调用约束与结果解释。 */
  toolDescription?: string;
  protocol: AigcInterfaceProtocol;
  capability: AigcInterfaceCapability;
  channelId: string;
  enabled: boolean;
  toolPublishEnabled: boolean;
  mcpPublishEnabled?: boolean;
  config: AigcOpenAiInterfaceConfig | AigcGrokInterfaceConfig | AigcComfyUiInterfaceConfig;
}

/** 外部 MCP 令牌的可授权操作。 */
export type AigcMcpOperation = "list" | "run" | "get" | "cancel" | "upload" | "download";

/** 管理界面只读取客户端元数据，令牌明文仅在签发响应出现。 */
export interface AigcMcpClient {
  id: string;
  name: string;
  interfaceIds: string[];
  operations: AigcMcpOperation[];
  createdAt: string;
  revokedAt?: string;
}

/** AIGC 任务状态。 */
export type AigcTaskStatus = "prepared" | "queued" | "running" | "succeeded" | "failed" | "cancelled";

/** 单次批量删除任务接口允许提交的最大任务数。 */
export const AIGC_TASK_BULK_DELETE_LIMIT = 500;

/** 任务产物引用。 */
export interface AigcTaskAsset {
  id: string;
  name: string;
  mediaType: string;
  /** 产物所属的稳定出参定义标识。 */
  outputId?: string;
  /** 产物所属的出参展示名称。 */
  outputName?: string;
  size: number;
  createdAt: string;
}

/** 任务失败时返回的脱敏错误。 */
export interface AigcTaskError {
  code: string;
  message: string;
}

/** ComfyUI 任务执行阶段。 */
export type AigcTaskExecutionPhase = "uploading" | "submitting" | "queued" | "running" | "downloading";

/** 执行中任务的瞬态进度，不写入长期任务历史。 */
export interface AigcTaskExecutionState {
  phase: AigcTaskExecutionPhase;
  currentNodeId?: string;
  currentNodeName?: string;
  currentNodeType?: string;
  progressValue?: number;
  progressMax?: number;
  completedNodes?: number;
  totalNodes?: number;
  queueAhead?: number;
  updatedAt: string;
}

/** 任务详情。 */
export interface AigcTaskRecord {
  /** Agent 创建时只校验参数，运行时复核后再准备媒体。 */
  preparation?: TaskPreparation;
  /** 首次提交执行的时间，用于执行配额，与创建时间分开。 */
  submittedAt?: string;
  /** 持久化提交序号，区分同毫秒及批次内顺序。 */
  queueOrder?: number;
  /** 当前本地排队原因，由调度器实时投影。 */
  queueReason?: string;
  /** 仅服务端写入；缺失表示历史或手动任务，不对 Agent 开放。 */
  agentOrigin?: {
    agentId: string;
    sessionId: string;
    requestKey: string;
    requestHash: string;
  };
  /** 外部 MCP 任务只归属签发时的客户端，不继承内部 Agent 权限。 */
  mcpOrigin?: {
    clientId: string;
    requestKey: string;
    requestHash: string;
  };
  /** 本地取消不等于上游停止，只有明确确认时标记 confirmed。 */
  upstreamCancellation?: "confirmed" | "unknown";
  /** 已交付到所属 Agent 工作区的产物路径，以资产 ID 为键。 */
  deliveredFiles?: Record<string, string>;
  id: string;
  interfaceId: string;
  interfaceName: string;
  channelId: string;
  status: AigcTaskStatus;
  inputs: Record<string, unknown>;
  assets: AigcTaskAsset[];
  execution?: AigcTaskExecutionState;
  error?: AigcTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 任务列表项。 */
export interface AigcTaskSummary {
  /** 本地调度等待原因。 */
  queueReason?: string;
  /** Agent 两阶段任务不允许通过工作台隐式重试。 */
  requiresNewTask?: boolean;
  /** 上游是否确认取消。 */
  upstreamCancellation?: "confirmed" | "unknown";
  id: string;
  interfaceId: string;
  interfaceName: string;
  channelId: string;
  status: AigcTaskStatus;
  assetCount: number;
  execution?: AigcTaskExecutionState;
  error?: AigcTaskError;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
}

/** 任务列表文档。 */
export interface AigcTaskDocument {
  tasks: AigcTaskSummary[];
}

/** 产物查看页支持的媒体分组。 */
export type AigcOutputKind = "image" | "video" | "audio" | "other";

/** 铺平后的单个 AIGC 任务产物。 */
export interface AigcOutputItem extends AigcTaskAsset {
  taskId: string;
  interfaceName: string;
  taskCreatedAt: string;
  kind: AigcOutputKind;
}

/** 各媒体分组的产物数量。 */
export type AigcOutputCounts = Record<AigcOutputKind, number>;

/** 服务端分页后的 AIGC 产物列表。 */
export interface AigcOutputPage {
  items: AigcOutputItem[];
  counts: AigcOutputCounts;
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

/** 媒体入参可选的来源。 */
export type AigcRunMediaSource = "upload" | "public" | "comfyui_input";

/** ComfyUI input 目录中的一个可选文件。 */
export interface AigcComfyUiInputFile {
  /** ComfyUI 可引用的文件名。 */
  filename: string;
  subfolder?: string;
  type?: string;
  /** 面向用户的展示名称。 */
  name: string;
  mediaType: string;
}

/** 手动试运行提交的入参。 */
export type AigcSingleRunInputValue =
  | boolean
  | number
  | string
  | { assetId: string; name: string; mediaType: string; source?: "upload" | "public" }
  | { url: string; name: string; mediaType: string }
  | { filename: string; name: string; mediaType: string; subfolder?: string; type?: string; source: "comfyui_input" };

/** 图片编辑可按输入顺序提供多张参考图。 */
export type AigcRunInputValue = AigcSingleRunInputValue | AigcSingleRunInputValue[];

/** 手动试运行请求。 */
export interface AigcRunRequest {
  interfaceId: string;
  inputs: Record<string, AigcRunInputValue>;
}

/** 上传到 AIGC 工作台的临时输入资产。 */
export interface AigcUploadedAsset {
  id: string;
  name: string;
  mediaType: string;
  size: number;
}

/** 保存在公共文件区中的 AIGC 输入文件。 */
export interface AigcPublicFileRecord {
  id: string;
  name: string;
  /** 面向用户的逻辑目录，根目录使用空字符串。 */
  directory: string;
  mediaType: string;
  size: number;
  createdAt: string;
}

/** 返回给浏览器的公共文件摘要，包含可直接访问的 URL。 */
export interface AigcPublicFileSummary extends AigcPublicFileRecord {
  url: string;
}

/** 公共文件列表文档。 */
export interface AigcPublicFileDocument {
  files: AigcPublicFileSummary[];
}

/** 公开目录中可浏览的文件或目录。 */
export interface AigcPublicDirectoryEntry {
  path: string;
  name: string;
  kind: "file" | "directory";
  modifiedAt: string;
  id?: string;
  mediaType?: string;
  size?: number;
  url?: string;
}
