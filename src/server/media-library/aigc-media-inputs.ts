import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { normalizePublicOrigin } from "../aigc/aigc-agent-service";
import { validateGrokInputs } from "../aigc/grok-adapter";
import type { AigcGrokInterfaceConfig } from "../../shared/aigc-contracts";
import { Readable } from "node:stream";
import type { AigcRunRequest, AigcSingleRunInputValue } from "../../shared/aigc-contracts";
import type { AigcAssetService } from "../aigc/aigc-asset-service";
import type { AigcPublicFileService } from "../aigc/aigc-public-file-service";
import type { AigcInterfaceService } from "../aigc/aigc-interface-service";
import type { AigcWorkflowService } from "../aigc/aigc-workflow-service";
import type { AigcTaskService } from "../aigc/aigc-task-service";
import { agentFields, validateAgentParameters } from "../aigc/aigc-agent-parameters";
import { DomainError } from "../core/errors";
import { isMediaReference, type MediaAccess } from "./media-access";

const entries = (value: AigcRunRequest["inputs"][string]) => Array.isArray(value) ? value : [value];

/** 工作台执行提交时固定媒体内容，复制失败或提交被拒绝时回收本次副本。 */
export async function submitMediaInputs(request: AigcRunRequest, deps: {
  mediaAccess: MediaAccess; publicOrigin?: string; assets: AigcAssetService; publicFiles: AigcPublicFileService;
  interfaces: AigcInterfaceService; workflows: AigcWorkflowService; tasks: AigcTaskService;
}) {
  if (!Object.values(request.inputs).some(value => entries(value).some(isMediaReference))) return deps.tasks.createRun(request);
  const item = await deps.interfaces.get(request.interfaceId);
  if (!item?.enabled) throw new DomainError("VALIDATION_FAILED", "目标 AIGC 接口不存在或已停用");
  const workflow = item.protocol === "comfyui" ? await deps.workflows.getPrivate((item.config as { workflowId: string }).workflowId) : undefined;
  const fields = agentFields(item, workflow);
  const selected = fields.filter(field => field.source && entries(request.inputs[field.name]).some(isMediaReference));
  for (const [name, value] of Object.entries(request.inputs))
    if (entries(value).some(isMediaReference) && !selected.some(field => field.name === name))
      throw new DomainError("VALIDATION_FAILED", "目标字段 " + name + " 不接受媒体库文件", { field: name });
  // 适配器接受上传资产与 URL 对象，字段校验只需保留它们的数量和顺序。
  validateAgentParameters(fields, Object.entries(request.inputs).map(([name, value]) => {
    if (!fields.find(field => field.name === name)?.source) return { name, value: value as string };
    const paths = entries(value).map(entry => typeof entry === "string" ? entry : "file");
    return { name, value: Array.isArray(value) ? paths : paths[0] };
  }));
  const publish = item.protocol === "grok";
  const origin = publish ? normalizePublicOrigin(deps.publicOrigin) : undefined;
  if (publish && !origin)
    throw new DomainError("VALIDATION_FAILED", "Grok 需要配置有效的公开 Origin", { field: selected[0].name });
  if (publish && request.confirmPublicTransfer !== true)
    throw new DomainError("VALIDATION_FAILED", "Grok 需要明确确认公网传输", { field: selected[0].name, requiresPublicTransfer: true });
  for (const field of selected)
    for (const ref of entries(request.inputs[field.name]).filter(isMediaReference))
      await deps.mediaAccess.describe(ref, field.name, field.type);
  if (publish) {
    const preview = { ...request.inputs };
    for (const field of selected) {
      const urls = entries(preview[field.name]).map(ref => isMediaReference(ref) ? origin + "/aigc-public/files/pending" : ref);
      preview[field.name] = Array.isArray(preview[field.name]) ? urls : urls[0];
    }
    validateGrokInputs(item.capability, item.config as AigcGrokInterfaceConfig, preview);
  }
  const uploads: string[] = [];
  try {
    const inputs = { ...request.inputs };
    for (const field of selected) {
      const results: AigcSingleRunInputValue[] = [];
      for (const ref of entries(inputs[field.name])) {
        if (!isMediaReference(ref)) { results.push(ref); continue; }
        const file = await deps.mediaAccess.read(ref, field.name, field.type);
        const stream = Readable.from(file.content);
        if (publish) {
          const saved = await deps.publicFiles.save(stream, randomUUID() + extname(file.name), file.mediaType);
          uploads.push(saved.id);
          results.push({ url: origin + "/aigc-public/files/" + saved.id, name: file.name, mediaType: file.mediaType });
        } else {
          const saved = await deps.assets.saveInput(stream, file.name, file.mediaType);
          uploads.push(saved.id);
          results.push({ assetId: saved.id, name: file.name, mediaType: file.mediaType });
        }
      }
      inputs[field.name] = Array.isArray(inputs[field.name]) ? results : results[0];
    }
    for (const field of selected)
      for (const ref of entries(request.inputs[field.name]).filter(isMediaReference))
        await deps.mediaAccess.describe(ref, field.name, field.type);
    return await deps.tasks.createRun({ interfaceId: item.id, inputs });
  } catch (error) {
    await Promise.all(uploads.map(id => publish ? deps.publicFiles.remove(id) : deps.assets.removeInput(id)));
    throw error;
  }
}
