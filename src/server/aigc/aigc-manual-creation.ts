import type {
  AigcBatchRequest, AigcGrokInterfaceConfig, AigcInterfaceRecord, AigcRerunDraft,
  AigcRunRequest, AigcSingleRunInputValue, AigcTaskRecord, AigcWorkflowDetail,
} from "../../shared/aigc-contracts";
import { taskFingerprint } from "../core/task-preparation";
import { DomainError, toSafePublicMessage } from "../core/errors";
import { withMediaInputs } from "../media-library/aigc-media-inputs";
import { isMediaReference, type MediaAccess } from "../media-library/media-access";
import { agentFields, validateAgentParameters, type AigcAgentField } from "./aigc-agent-parameters";
import type { AigcAssetService } from "./aigc-asset-service";
import type { AigcComfyUiInputService } from "./aigc-comfyui-input-service";
import type { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcPublicFileService } from "./aigc-public-file-service";
import type { AigcTaskService } from "./aigc-task-service";
import type { AigcWorkflowService } from "./aigc-workflow-service";
import { validateGrokInputs } from "./grok-adapter";

interface CreationDependencies {
  interfaces: AigcInterfaceService;
  workflows: AigcWorkflowService;
  tasks: AigcTaskService;
  mediaAccess?: MediaAccess;
  assets: AigcAssetService;
  publicFiles: AigcPublicFileService;
  comfyuiInputs: AigcComfyUiInputService;
  publicOrigin?: string;
}

function currentWorkflow(item: AigcInterfaceRecord, deps: CreationDependencies) {
  return item.protocol === "comfyui"
    ? deps.workflows.get((item.config as { workflowId: string }).workflowId).then(result => result.workflow)
    : undefined;
}

/** 用当前工作台的接口定义和媒体访问边界准备一份可编辑表单。 */
async function projectInputs(deps: CreationDependencies, item: AigcInterfaceRecord,
  workflow: AigcWorkflowDetail | undefined, saved: Record<string, unknown>, task?: AigcTaskRecord): Promise<AigcRerunDraft> {
  const fields = agentFields(item, workflow);
  for (const mapping of workflow?.inputMappings ?? []) {
    const definition = fields.find(field => field.name === mapping.name)!;
    if (definition.source) continue;
    const metadata = workflow?.resolvedFieldMetadata?.[mapping.nodeId]?.[mapping.field];
    definition.defaultValue ??= metadata?.defaultValue ?? (mapping.type === "bool" ? false :
      mapping.type === "enum" ? definition.enumValues?.[0] : undefined);
  }
  const inputs: AigcRunRequest["inputs"] = Object.create(null);
  const issues: AigcRerunDraft["issues"] = [];
  function report(field: string, message: string) {
    if (!task) throw new DomainError("VALIDATION_FAILED", message, { field });
    issues.push({ field, message });
  }
  for (const name of Object.keys(saved)) {
    if (!fields.some(field => field.name === name)) report(name, "当前接口已无参数 " + name);
  }
  for (const field of fields) {
    const value = Object.hasOwn(saved, field.name) ? saved[field.name] : undefined;
    if (field.source) {
      if (value === undefined) {
        if (field.required) report(field.name, "缺少必填媒体参数 " + field.name);
        continue;
      }
      const entries = Array.isArray(value) ? value : [value];
      if ((Array.isArray(value) && !field.multiple) || !entries.length || entries.length > (field.maxItems ?? 1)) {
        report(field.name, "参数 " + field.name + " 的媒体数量与当前接口不符");
        continue;
      }
      const accepted: AigcSingleRunInputValue[] = [];
      for (const entry of entries) {
        try {
          accepted.push(await resolveMedia(deps, item, field, entry, workflow, task));
        } catch (error) {
          if (!task) throw error;
          if (error instanceof DomainError && ["VALIDATION_FAILED", "NOT_FOUND", "FORBIDDEN"].includes(error.code)) {
            report(field.name, error.message);
          } else if (error instanceof TypeError) {
            report(field.name, "无法核对媒体 " + field.name + "：" + toSafePublicMessage(error, "媒体来源未返回可读错误"));
          } else {
            throw error;
          }
        }
      }
      if (accepted.length) inputs[field.name] = Array.isArray(value) ? accepted : accepted[0];
      continue;
    }
    try {
      if (typeof value === "string" && ((task?.preparation && Object.hasOwn(task.preparation.files, value))
        || ((task?.mcpOrigin || task?.agentOrigin) && URL.canParse(value) && new URL(value).pathname.startsWith("/aigc-public/files/"))))
        throw new TypeError("原任务参数 " + field.name + " 为私有文件，请重新填写");
      if (value !== undefined && typeof value !== "boolean" && typeof value !== "number" && typeof value !== "string")
        throw new TypeError("参数 " + field.name + " 与当前字段类型不符");
      const validated = validateAgentParameters([field], value === undefined ? [] : [{ name: field.name, value }]);
      if (Object.hasOwn(validated, field.name)) inputs[field.name] = validated[field.name];
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      report(field.name, error.message);
    }
  }
  return { interfaceId: item.id, interfaceAvailable: true, inputs, issues };
}

/** 只投影当前来源允许的媒体字段，不复用其他调用方的临时副本。 */
async function resolveMedia(deps: CreationDependencies, item: AigcInterfaceRecord, field: AigcAgentField,
  value: unknown, workflow?: AigcWorkflowDetail, task?: AigcTaskRecord): Promise<AigcSingleRunInputValue> {
  const missing = () => new DomainError("NOT_FOUND", "参数 " + field.name + " 的媒体不可用，请重新选择", { field: field.name });
  if (isMediaReference(value)) {
    if (!deps.mediaAccess) throw missing();
    await deps.mediaAccess.describe(value, field.name, field.type);
    return value;
  }
  if (task?.agentOrigin || task?.mcpOrigin) throw missing();
  const ref = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (item.protocol === "grok") {
    const url = typeof value === "string" ? value : ref.url;
    if (typeof url !== "string" || !URL.canParse(url)) throw missing();
    const parsed = new URL(url);
    if (!["https:", "http:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash) throw missing();
    const local = /^\/aigc-public\/files\/([^/]+)$/u.exec(parsed.pathname);
    if (local && !await deps.publicFiles.resolvePath(local[1])) throw missing();
    if (typeof value === "string") return url;
    if (typeof ref.name === "string" && typeof ref.mediaType === "string" && ref.mediaType.startsWith(field.type + "/"))
      return { url, name: ref.name, mediaType: ref.mediaType };
    throw missing();
  }
  if (ref.source === "comfyui_input" && workflow) {
    if (task && task.channelId !== item.channelId) throw missing();
    const mapping = workflow.inputMappings.find(mapping => mapping.name === field.name)!;
    const node = workflow.nodes.find(node => node.id === mapping.nodeId);
    const options = node && await deps.comfyuiInputs.list(item.channelId, node.type, mapping.field);
    const file = options?.find(file => file.filename === ref.filename && file.subfolder === ref.subfolder && file.mediaType.startsWith(field.type + "/"));
    if (file) return { ...file, source: "comfyui_input" };
    throw missing();
  }
  if (typeof ref.assetId !== "string" || typeof ref.name !== "string" || typeof ref.mediaType !== "string"
    || !ref.mediaType.startsWith(field.type + "/") || (ref.source !== undefined && ref.source !== "upload" && ref.source !== "public")) throw missing();
  const exists = ref.source === "public" ? await deps.publicFiles.resolvePath(ref.assetId) : await deps.assets.resolveInputPath(ref.assetId);
  if (!exists) throw missing();
  return { assetId: ref.assetId, name: ref.name, mediaType: ref.mediaType, ...(ref.source === "public" ? { source: "public" } : {}) };
}

/** 受理前固定生效入参和媒体顺序，复制期间定义变化时撤销本次准备。 */
export function submitManualBatch(request: AigcBatchRequest, deps: CreationDependencies) {
  return deps.tasks.createManualBatch(request, async (item, accept) => {
    const workflow = await currentWorkflow(item, deps);
    const { inputs } = await projectInputs(deps, item, workflow, request.inputs);
    const submit = async (prepared: AigcRunRequest) => {
      if (item.protocol === "grok") validateGrokInputs(item.capability, item.config as AigcGrokInterfaceConfig, prepared.inputs);
      const latest = await deps.interfaces.get(item.id);
      if (taskFingerprint(latest ?? null) !== taskFingerprint(item)
        || (workflow && taskFingerprint(await currentWorkflow(item, deps)) !== taskFingerprint(workflow)))
        throw new DomainError("CONFLICT", "媒体准备期间接口或工作流定义已变化，请刷新创作表单");
      return accept(prepared.inputs, inputs);
    };
    const normalized = { ...request, inputs };
    return deps.mediaAccess ? withMediaInputs(normalized, { ...deps, mediaAccess: deps.mediaAccess }, submit) : submit(normalized);
  });
}

/** 读取历史业务入参并复核可用字段，打开草稿不进入调度队列。 */
export async function readRerunDraft(id: string, deps: CreationDependencies): Promise<AigcRerunDraft> {
  const task = await deps.tasks.get(id);
  if (!task) throw new DomainError("NOT_FOUND", "AIGC 任务不存在");
  const item = await deps.interfaces.get(task.interfaceId);
  if (!item?.enabled) return { interfaceId: task.interfaceId, interfaceAvailable: false, inputs: {},
    issues: [{ message: "原接口已删除或停用，请手动选择接口" }] };
  return projectInputs(deps, item, await currentWorkflow(item, deps), task.creationInputs ?? task.preparation?.values ?? task.inputs, task);
}
