import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hasFailedTasks } from "../core/task-preparation";
import { toSafePublicMessage } from "../core/errors";
import { AigcAgentError, type AigcAgentContext, type AigcAgentService } from "./aigc-agent-service";

const interfaceDiscoveryParameters = Type.Object({
  action: Type.Union([Type.Literal("list"), Type.Literal("get")], {
    description: "list 分页列出接口；get 按列表返回的真实 ID 读取详情",
  }),
  interfaceId: Type.Union([
    Type.String({ minLength: 1, maxLength: 120 }),
    Type.Null(),
  ], { description: "list 必须传 JSON null；get 必须传列表返回的真实接口 ID" }),
  offset: Type.Union([
    Type.Integer({ minimum: 0 }),
    Type.Null(),
  ], { description: "list 首次传 0、后续传 nextOffset；get 必须传 JSON null" }),
}, { additionalProperties: false });

/** 为当前会话创建固定名称工具，授权仍由 SDK 和应用服务分别校验。 */
export function createAigcAgentTools(context: AigcAgentContext, service: AigcAgentService) {
  // 字段列表属于工具对象内部的属性，不是工具 parameters 根 Schema。
  const parameterEntries = Type.Array(Type.Object({
    name: Type.String({ minLength: 1, maxLength: 80 }),
    value: Type.Union([
      Type.String({ maxLength: 20_000 }),
      Type.Number(),
      Type.Boolean(),
      Type.Array(Type.String({ minLength: 1, maxLength: 1_024 }), { minItems: 1, maxItems: 16 }),
      Type.Null(),
    ], { description: "按接口字段类型提供原生 JSON 值；媒体可传工作区相对路径或 media_library 返回的 reference，图片编辑 image 支持有序数组，可选媒体未提供时传 JSON null" }),
  }, { additionalProperties: false }), { maxItems: 100, description: "每项只提供 name 和 value，禁止添加其他值字段" });
  const runParameters = Type.Object({ taskIds: Type.Array(Type.String({ minLength: 1, maxLength: 120 }), { minItems: 1, maxItems: 2, uniqueItems: true }) }, { additionalProperties: false });
  return [
    defineTool({
      name: "aigc_list_interfaces", label: "查询 AIGC 接口",
      description: "列出已发布接口或按真实 ID 读取 Agent 专用说明、入参和出参定义。必须显式选择 action，禁止猜测 interfaceId。",
      promptSnippet: '发现接口时传 {"action":"list","interfaceId":null,"offset":0}；读取详情时传 {"action":"get","interfaceId":"列表返回的 ID","offset":null}。',
      parameters: interfaceDiscoveryParameters,
      execute: async (_id, params) => result(() => service.list(context, normalizeInterfaceDiscoveryInput(params))),
    }),
    defineTool({
      name: "aigc_create_task", label: "创建 AIGC 任务",
      description: "先查询接口字段，再创建任务。只校验并保存，返回 taskId 和生效参数，不上传上游、不运行、不计费。创建重试复用 requestKey。",
      parameters: Type.Object({
        interfaceId: Type.String({ minLength: 1, maxLength: 120 }),
        requestKey: Type.String({ minLength: 1, maxLength: 80, pattern: "^[A-Za-z0-9_-]+$" }),
        parameters: parameterEntries,
      }, { additionalProperties: false }),
      execute: async (_id, params, signal) => result(() => service.create(context, params, signal)),
    }),
    defineTool({
      name: "aigc_run", label: "运行 AIGC 任务",
      description: "传入创建工具返回的 taskIds 数组（1～2 个），整批校验后一起提交后台运行并立即返回。可能计费；重复 ID 不重新生成。",
      parameters: runParameters,
      execute: async (_id, params, signal) => result(() => service.run(context, params, signal)),
    }),
    defineTool({
      name: "aigc_get_task", label: "查询 AIGC 任务",
      description: "读取当前 Agent 的任务进度和产物；查询间隔至少 2 秒。完成时返回可直接写入 Markdown 链接的工作区相对路径。",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id, params) => result(() => service.get(context, params.taskId)),
    }),
    defineTool({
      name: "aigc_cancel_task", label: "取消 AIGC 任务",
      description: "取消当前 Agent 的任务。仅 upstreamCancellation=confirmed 表示上游已确认停止；unknown 时可能仍在计算或计费。",
      parameters: Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 120 }) }, { additionalProperties: false }),
      execute: async (_id, params) => result(() => service.cancel(context, params.taskId)),
    }),
    defineTool({
      name: "aigc_run_and_wait", label: "生成并等待 AIGC 产物",
      description: "传入创建工具返回的 taskIds 数组（1～2 个），先一起提交后台再等待全部终态，分别返回产物或错误。最多等待 30 分钟；超时或中止聊天只结束等待。再次传原 ID 继续等待，不重新生成。",
      promptSnippet: "需要本次对话获得产物时，先创建所有任务，再一次传入全部 taskIds 调用 aigc_run_and_wait。",
      parameters: runParameters,
      execute: async (_id, params, signal, onUpdate) => result(() => service.runAndWait(context, params, signal, (state) => {
        onUpdate?.({ content: [{ type: "text", text: JSON.stringify({ status: "waiting", data: state }) }], details: {} });
      })),
    }),
  ];
}

/** 将严格判别参数转换为服务层已有的列表或详情查询。 */
function normalizeInterfaceDiscoveryInput(input: unknown): { interfaceId?: string; offset?: number } {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("AIGC 接口查询参数必须是对象");
  }
  const params = input as Record<string, unknown>;
  if (params.action === "list") {
    if (params.interfaceId !== null || !Number.isInteger(params.offset) || (params.offset as number) < 0) {
      throw new TypeError("list 必须传 interfaceId=null，并传入非负整数 offset；首次调用 offset=0");
    }
    return { offset: params.offset as number };
  }
  if (params.action === "get") {
    if (typeof params.interfaceId !== "string" || !params.interfaceId || params.offset !== null) {
      throw new TypeError("get 必须传列表返回的真实 interfaceId，并传 offset=null");
    }
    return { interfaceId: params.interfaceId };
  }
  throw new TypeError("action 必须是 list 或 get");
}

/** 工具输出限制大小，失败抛出脱敏错误以让 Pi 正确标记 isError。 */
async function result(operation: () => Promise<unknown>) {
  let data: unknown;
  try {
    data = await operation();
    const text = JSON.stringify({ status: "ok", data });
    if (Buffer.byteLength(text, "utf8") > 64 * 1024) throw new AigcAgentError("AIGC_RESULT_TOO_LARGE", "接口字段过多，请在 AIGC 工作台精简发布参数");
  } catch (error) {
    const code = error instanceof AigcAgentError ? error.code : error instanceof TypeError ? "AIGC_INPUT_INVALID" : "AIGC_OPERATION_FAILED";
    const message = toSafePublicMessage(error, "AIGC Agent 工具捕获到非 Error 异常");
    throw new Error(JSON.stringify({ code, message }));
  }
  if (hasFailedTasks(data)) throw new Error(JSON.stringify({ code: "AIGC_TASK_FAILED", message: "AIGC 任务执行失败，请检查各任务错误；同批成功产物已保留", data }));
  return { content: [{ type: "text" as const, text: JSON.stringify({ status: "ok", data }) }], details: {} };
}
