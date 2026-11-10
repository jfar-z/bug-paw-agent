import type { TaskPreparation } from "./task-preparation-contracts";
import type { ThinkingLevel } from "./configuration-contracts";
import type { ApiErrorDocument } from "./api/common";

/** 跨服务传递的工作流参数类型；数组通过 multiple 声明，不混入枚举。 */
export type WorkflowValueType =
  | "string"
  | "float"
  | "integer"
  | "boolean"
  | "object"
  | "image"
  | "video"
  | "audio"
  | "file";
/** 可序列化、可检查的工作流参数定义。 */
export interface WorkflowField {
  name: string;
  type: WorkflowValueType;
  multiple?: boolean;
  required?: boolean;
  description?: string;
  defaultValue?: unknown;
  /** 通用参数的枚举是字符串约束，外部接口可保留原始标量选项。 */
  enumValues?: (string | number | boolean)[];
  /** 仅引用类型定义，不作为运行时数据依赖。 */
  enumSource?: { nodeId: string; field: string } & (
    | { interfaceId: string; workflowId?: never; loop?: never }
    | { workflowId: string; interfaceId?: never; loop?: never }
    | { loop: true; interfaceId?: never; workflowId?: never }
  );
}
/** 外部能力输入由接口固定类型，并保留枚举、数值及数量约束。 */
export interface WorkflowInputField extends WorkflowField {
  min?: number;
  max?: number;
  maxItems?: number;
}
/** 脚本辅助仅接收当前节点上下文，不携带其他节点脚本或运行数据。 */
export interface WorkflowScriptAssistRequest {
  provider: string;
  modelId: string;
  /** 未指定时采用模型默认思考行为。 */
  thinkingLevel?: ThinkingLevel;
  requirement: string;
  script: string;
  inputs: {
    name: string;
    type?: WorkflowValueType;
    multiple?: boolean;
    description?: string;
    source: WorkflowBinding;
  }[];
  outputs: WorkflowField[];
  timeoutMs: number;
}
/** 生成过程只公开文字增量，不传递 SDK 的签名、凭据或完整消息。 */
export type WorkflowScriptAssistProgress =
  | { type: "started" | "validating" }
  | { type: "thinking_delta" | "text_delta"; delta: string };
/** 完成事件中的脚本已通过语法检查，增量内容不能直接应用。 */
export type WorkflowScriptAssistEvent =
  | WorkflowScriptAssistProgress
  | { type: "completed"; script: string }
  | { type: "error"; error: ApiErrorDocument["error"] };

/** 媒体只传递受控资产引用，不能携带宿主路径。 */
export interface WorkflowFile {
  /** 历史记录保留引用，已清理的文件明确显示删除状态。 */
  deleted?: boolean;
  assetId: string;
  name: string;
  mediaType: string;
  size: number;
}
/** 文件管理以资产 ID 去重，运行和常量目录保持独立。 */
export interface WorkflowManagedFile extends WorkflowFile {
  directory: "runtime" | "constants";
  createdAt: string;
  deletedAt?: string;
  usages: { workflowId: string; workflowName: string; runId?: string; role: "constant" | "input" | "output" }[];
  blockedReason?: string;
}
/** 文件列表只返回当前页，避免大运行历史一次性进入浏览器。 */
export interface WorkflowFilePage {
  files: WorkflowManagedFile[];
  total: number;
  page: number;
  workflows: { id: string; name: string }[];
}
/** 输入来源为常量或上游节点的命名输出。 */
export type WorkflowBinding =
  | { kind: "literal"; value: unknown }
  | { kind: "reference"; nodeId: string; field: string };
/** 支持的节点集合；循环内部仍遵循 DAG 约束。 */
export type WorkflowNodeKind =
  | "input"
  | "output"
  | "llm"
  | "agent"
  | "aigc"
  | "condition"
  | "select"
  | "loop"
  | "workflow"
  | "javascript"
  | "semaphore_acquire"
  | "semaphore_release";
/** 条件使用有限运算符，不对用户字符串执行代码。 */
export interface WorkflowCondition {
  left: WorkflowBinding;
  operator:
    | "eq"
    | "ne"
    | "gt"
    | "gte"
    | "lt"
    | "lte"
    | "contains"
    | "empty"
    | "not_empty";
  right: WorkflowBinding;
}
/** 节点的专属设置，未使用的设置不参与当前节点执行。 */
export interface WorkflowNodeConfig {
  /** 共享资源信号量的稳定 code；数量从输入 count 读取。 */
  semaphoreCode?: string;
  /** 子工作流按稳定 ID 调用，执行时使用根任务预先固定的快照。 */
  workflowId?: string;
  /** 循环体是隔离的 DAG，内外只能通过输入和输出映射传值。 */
  loop?: WorkflowLoop;
  provider?: string;
  modelId?: string;
  systemPrompt?: string;
  thinking?:
    "inherit" | "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  temperature?: number;
  topP?: number;
  maxTokens?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  customParameters?: Record<string, unknown>;
  agentId?: string;
  sessionMode?: "new" | "fixed";
  sessionId?: string;
  archiveAfterCompletion?: boolean;
  interfaceId?: string;
  /** 未配置的参考组沿用拆分输入；数组模式单独保存上游绑定。 */
  referenceGroups?: Record<
    string,
    { mode: "array"; binding?: WorkflowBinding }
  >;
  conditions?: WorkflowCondition[];
  conditionMode?: "all" | "any";
  candidates?: WorkflowBinding[];
  selectMode?: "first_available" | "condition";
  selectCondition?: WorkflowCondition;
  script?: string;
  timeoutMs?: number;
}
/** 循环变量在整轮成功后更新，条件只能读取本轮输入上下文。 */
export interface WorkflowLoop {
  mode: "count" | "array" | "while";
  maxIterations: number;
  count: WorkflowBinding;
  items: WorkflowBinding;
  condition: WorkflowCondition;
  state: Record<string, { initial: WorkflowBinding; output: string }>;
  outputs: Record<
    string,
    { field: string; mode: "collect" | "flatten" | "last" }
  >;
  body: WorkflowDraft;
}
/** 节点输入映射与输出类型是运行时校验的依据。 */
export interface WorkflowNode {
  id: string;
  kind: WorkflowNodeKind;
  name: string;
  position: { x: number; y: number };
  inputs: Record<string, WorkflowBinding>;
  outputs: WorkflowField[];
  config: WorkflowNodeConfig;
}
/** 控制边决定执行可达性；判断节点的边带有 true/false 分支。 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
  branch?: "true" | "false";
}
/** 管理员保存的工作流定义；revision 用于乐观并发保护。 */
export interface WorkflowDefinition {
  id: string;
  name: string;
  description: string;
  revision: number;
  published: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  createdAt: string;
  updatedAt: string;
}
/** 工作流列表只公开数据库摘要；编辑和运行按 ID 请求完整定义。 */
export type WorkflowSummary = Omit<WorkflowDefinition, "nodes" | "edges"> & {
  nodeCount: number;
};
export type WorkflowDraft = Pick<
  WorkflowDefinition,
  "name" | "description" | "published" | "nodes" | "edges"
>;
export type WorkflowStatus =
  "prepared" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "skipped";
/** 节点错误保留安全消息、稳定代码和运行追踪标识。 */
export interface WorkflowError {
  code: string;
  message: string;
  requestId: string;
  nodeId?: string;
}
export interface WorkflowNodeRun {
  /** 子工作流或每一轮的独立轨迹，均随根任务保存。 */
  children?: WorkflowRun[];
  nodeId: string;
  status: WorkflowStatus;
  inputs?: Record<string, unknown>;
  referenceGroups?: Record<string, unknown>;
  outputs?: Record<string, unknown>;
  startedAt?: string;
  finishedAt?: string;
  error?: WorkflowError;
  progress?: string;
  events: { at: string; message: string }[];
}
/** 一次运行持有不可变定义快照，避免编辑影响正在执行的任务。 */
export interface WorkflowRun {
  /** 实际启动时间；排队不消耗小时额度。 */
  startedAt?: string;
  /** 待运行参数与输入文件指纹，只有显式运行后才导入媒体。 */
  preparation?: TaskPreparation;
  /** 首次提交运行时间，不以创建时间计算运行配额。 */
  submittedAt?: string;
  /** 持久化提交序号，区分同毫秒及批次内顺序。 */
  queueOrder?: number;
  /** 当前本地排队原因，由调度器实时投影。 */
  queueReason?: string;
  /** 整棵调用树在启动时固定定义，运行期间不再读取最新文件。 */
  dependencies?: Record<string, WorkflowDefinition>;
  id: string;
  workflowId: string;
  definition: WorkflowDefinition;
  status: WorkflowStatus;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  nodes: WorkflowNodeRun[];
  createdAt: string;
  finishedAt?: string;
  error?: WorkflowError;
  origin?: { agentId: string; sessionId: string };
  requestKey: string;
  requestHash: string;
}
/** 参考组只公开类型与有序参数名，不暴露 ComfyUI 内部节点。 */
export interface WorkflowReferenceGroup {
  id: string;
  label: string;
  type: "image" | "video" | "audio";
  fields: string[];
}
/** 编辑器目录仅包含安全配置摘要。 */
export interface WorkflowCatalog {
  /** 共享资源目录仅公开配置摘要。 */
  semaphores?: WorkflowSemaphore[];
  /** 仅供管理员选择的安全摘要；参数定义在选择时单独读取。 */
  workflows?: (Pick<WorkflowSummary, "id" | "name"> & {
    dependencies: string[];
    unavailable?: string;
    /** 仅公开输入枚举的选项，不携带默认值、输入映射或内部节点配置。 */
    enumFields?: { name: string; values: string[] }[];
  })[];
  models: {
    provider: string;
    id: string;
    name: string;
    reasoning: boolean;
    thinkingLevels?: ThinkingLevel[];
    images: boolean;
  }[];
  agents: { id: string; name: string }[];
  interfaces: {
    id: string;
    name: string;
    fields: WorkflowInputField[];
    referenceGroups?: WorkflowReferenceGroup[];
    outputs: WorkflowField[];
  }[];
}
export const WORKFLOW_TYPES: WorkflowValueType[] = [
  "string",
  "float",
  "integer",
  "boolean",
  "object",
  "image",
  "video",
  "audio",
  "file",
];
export const WORKFLOW_NODE_NAMES: Record<WorkflowNodeKind, string> = {
  input: "输入",
  output: "输出",
  llm: "大模型",
  agent: "Agent",
  aigc: "AIGC",
  condition: "判断",
  select: "选择",
  loop: "循环",
  workflow: "工作流",
  javascript: "JS 脚本",
  semaphore_acquire: "获取信号量",
  semaphore_release: "释放信号量",
};

/** 新建节点时给出可编辑默认值，不伪造模型、Agent 或接口标识。 */
export function newWorkflowNode(
  kind: WorkflowNodeKind,
  id: string,
  position = { x: 300, y: 160 },
): WorkflowNode {
  const node: WorkflowNode = {
    id,
    kind,
    name: WORKFLOW_NODE_NAMES[kind],
    position,
    inputs: {},
    outputs: [],
    config: {},
  };
  if (kind === "semaphore_acquire" || kind === "semaphore_release") node.inputs = { count: { kind: "literal", value: 1 } };
  if (kind === "input")
    node.outputs = [
      {
        name: "prompt",
        type: "string",
        required: true,
        description: "本次任务需求",
      },
    ];
  if (kind === "output")
    node.outputs = [{ name: "result", type: "string", required: true }];
  if (kind === "llm") {
    node.config = {
      thinking: "inherit",
      temperature: 0.7,
      topP: 1,
      maxTokens: 4096,
      frequencyPenalty: 0,
      presencePenalty: 0,
      customParameters: {},
      systemPrompt: "",
    };
    node.outputs = [{ name: "text", type: "string", required: true }];
  }
  if (kind === "agent") {
    node.config = { sessionMode: "new", archiveAfterCompletion: false };
    node.outputs = [
      { name: "text", type: "string" },
      { name: "files", type: "file", multiple: true },
      { name: "sessionId", type: "string" },
    ];
  }
  if (kind === "aigc")
    node.outputs = [{ name: "files", type: "file", multiple: true }];
  if (kind === "condition") {
    node.config = {
      conditionMode: "all",
      conditions: [
        {
          left: { kind: "literal", value: true },
          operator: "eq",
          right: { kind: "literal", value: true },
        },
      ],
    };
    node.outputs = [{ name: "result", type: "boolean", required: true }];
  }
  if (kind === "select") {
    node.config = { selectMode: "first_available", candidates: [] };
    node.outputs = [{ name: "result", type: "string" }];
  }
  if (kind === "javascript") {
    node.config = {
      script:
        '// inputs 包含本节点映射的输入；返回值应与输出定义一致。\nreturn { result: String(inputs.value ?? "") };',
      timeoutMs: 1000,
    };
    node.inputs = { value: { kind: "literal", value: "" } };
    node.outputs = [{ name: "result", type: "string", required: true }];
  }
  if (kind === "loop") {
    const body = emptyWorkflow();
    body.name = "循环体";
    body.nodes[0].outputs = [
      { name: "index", type: "integer", required: true },
    ];
    body.nodes[1].outputs = [
      { name: "result", type: "integer", required: true },
    ];
    body.nodes[1].inputs.result = {
      kind: "reference",
      nodeId: "input",
      field: "index",
    };
    node.config.loop = {
      mode: "count",
      maxIterations: 100,
      count: { kind: "literal", value: 3 },
      items: { kind: "literal", value: [] },
      condition: {
        left: { kind: "reference", nodeId: "input", field: "index" },
        operator: "lt",
        right: { kind: "literal", value: 3 },
      },
      state: {},
      outputs: { result: { field: "result", mode: "collect" } },
      body,
    };
    node.outputs = [
      { name: "result", type: "integer", multiple: true, required: true },
    ];
  }
  return node;
}

/** 显式遍历循环作用域，不把常量 JSON 中的相似字段当成节点或引用。 */
export function workflowNodesDeep(
  graph: Pick<WorkflowDraft, "nodes">,
): WorkflowNode[] {
  return graph.nodes.flatMap((node) => [
    node,
    ...(node.kind === "loop" && node.config.loop
      ? workflowNodesDeep(node.config.loop.body)
      : []),
  ]);
}

/** 循环输出从内部出参派生，数组采用合并模式，避免制造不受支持的二维类型。 */
export function workflowLoopOutputs(
  loop: WorkflowLoop,
  previous: WorkflowField[] = [],
): WorkflowField[] {
  const fields =
    loop.body.nodes.find((node) => node.kind === "output")?.outputs ?? [];
  return Object.entries(loop.outputs).flatMap(([name, mapping]) => {
    const source = fields.find((field) => field.name === mapping.field);
    return source
      ? [
          {
            ...source,
            name,
            enumSource: undefined,
            multiple: mapping.mode === "last" ? source.multiple : true,
            defaultValue:
              mapping.mode === "last"
                ? (previous.find(
                    (field) =>
                      field.name === name &&
                      field.type === source.type &&
                      !!field.multiple === !!source.multiple,
                  )?.defaultValue ?? source.defaultValue)
                : undefined,
          },
        ]
      : [];
  });
}

/** 默认流程可直接运行，以输入到输出验证完整链路。 */
export function emptyWorkflow(): WorkflowDraft {
  const input = newWorkflowNode("input", "input", { x: 80, y: 140 });
  const output = newWorkflowNode("output", "output", { x: 440, y: 140 });
  output.inputs.result = {
    kind: "reference",
    nodeId: "input",
    field: "prompt",
  };
  return {
    name: "新工作流",
    description: "",
    published: false,
    nodes: [input, output],
    edges: [{ id: "input-output", source: "input", target: "output" }],
  };
}

/**
 * 按运行快照的 DAG 分层展示节点，同层保留定义顺序，不受状态或时间影响。
 * 定义在保存及启动时已验证无环；排序只创建展示副本，不修改运行状态数组。
 */
export function workflowRunNodesInOrder(run: WorkflowRun): WorkflowNodeRun[] {
  const { nodes, edges } = run.definition;
  const indegrees = new Map(nodes.map((node) => [node.id, 0]));
  const children = new Map(nodes.map((node) => [node.id, [] as string[]]));
  for (const edge of edges) {
    indegrees.set(edge.target, indegrees.get(edge.target)! + 1);
    children.get(edge.source)!.push(edge.target);
  }
  const order = new Map<string, number>();
  let layer = nodes.filter((node) => indegrees.get(node.id) === 0);
  while (layer.length) {
    for (const node of layer) {
      order.set(node.id, order.size);
      for (const child of children.get(node.id)!)
        indegrees.set(child, indegrees.get(child)! - 1);
    }
    layer = nodes.filter(
      (node) => !order.has(node.id) && indegrees.get(node.id) === 0,
    );
  }
  return [...run.nodes].sort(
    (a, b) => order.get(a.nodeId)! - order.get(b.nodeId)!,
  );
}

/** 共享资源配置，code 创建后不可改名。 */
export interface WorkflowSemaphoreInput {
  code: string;
  name: string;
  limit: number;
}
/** 乐观版本防止多窗口配置互相覆盖。 */
export interface WorkflowSemaphore extends WorkflowSemaphoreInput {
  revision: number;
}
/** 实时用量仅属于当前服务进程，运行中断后自动归零。 */
export interface WorkflowSemaphoreView extends WorkflowSemaphore {
  used: number;
  available: number;
  holders: { runId: string; count: number }[];
  waiting: { runId: string; count: number }[];
}
