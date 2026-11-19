import { normalizePublicOrigin } from "../aigc/aigc-agent-service";
import { Readable } from "node:stream";
import type { WorkflowDefinition, WorkflowField, WorkflowDraft } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
import type { AigcInterfaceService } from "../aigc/aigc-interface-service";
import type { WorkflowFiles } from "../workflows/workflow-files";
import { isMediaReference, type MediaAccess } from "./media-access";

/** 跟踪文件可能到达的公网节点，引用组、循环和子工作流也在检查范围内。 */
async function reachesPublic(scope: WorkflowDraft, fields: Set<string>, dependencies: Record<string, WorkflowDefinition>,
  interfaces: AigcInterfaceService): Promise<boolean> {
  const input = scope.nodes.find(node => node.kind === "input")!;
  const affected = new Set<string>();
  const references = (value: unknown): boolean => {
    if (!value || typeof value !== "object") return false;
    const obj = value as Record<string, unknown>;
    if (obj.kind === "literal") return false;
    if (obj.kind === "reference") return obj.nodeId === input.id ? fields.has(String(obj.field)) : affected.has(String(obj.nodeId));
    return Object.values(obj).some(references);
  };
  // 节点存储顺序取决于编辑过程，传播至不动点后再判断公网接收方。
  let before: number;
  do {
    before = affected.size;
    for (const node of scope.nodes)
      if (!affected.has(node.id) && (references(node.inputs) || references(node.config.referenceGroups) ||
        references(node.config.candidates) || references(node.config.loop?.items) || references(node.config.loop?.state)))
        affected.add(node.id);
  } while (affected.size !== before);
  for (const node of scope.nodes.filter(n => affected.has(n.id))) {
    if (node.kind === "aigc" && (await interfaces.get(node.config.interfaceId!))?.protocol === "grok") return true;
    const child = node.kind === "workflow" ? dependencies[node.config.workflowId!] : node.config.loop?.body;
    if (!child) continue;
    const names = node.kind === "loop" ? child.nodes.find(n => n.kind === "input")!.outputs.map(f => f.name) :
      Object.entries(node.inputs).filter(([, binding]) => references(binding)).map(([name]) => name);
    if (await reachesPublic(child, new Set(names), dependencies, interfaces)) return true;
  }
  return false;
}

export class WorkflowMediaInputs {
  constructor(private access: MediaAccess, private files: WorkflowFiles, private interfaces: AigcInterfaceService,
    private publicOrigin?: string) {}

  async copyForRun(definition: WorkflowDefinition, dependencies: Record<string, WorkflowDefinition>, inputs: Record<string, unknown>,
    agentId: string | undefined, confirm: boolean, uploaded: string[], checks: (() => Promise<unknown>)[]) {
    const result = { ...inputs };
    for (const field of definition.nodes.find(n => n.kind === "input")!.outputs) {
      if (!["image", "audio", "video", "file"].includes(field.type)) continue;
      const value = inputs[field.name];
      const entries = Array.isArray(value) ? value : [value];
      if (!entries.some(isMediaReference)) continue;
      const publish = await reachesPublic(definition, new Set([field.name]), dependencies, this.interfaces);
      if (publish && !normalizePublicOrigin(this.publicOrigin))
        throw new DomainError("VALIDATION_FAILED", "参数 " + field.name + " 可能传给 Grok，需要配置可访问的公网 Origin", { field: field.name });
      if (publish && agentId === undefined && !confirm)
        throw new DomainError("VALIDATION_FAILED", "参数 " + field.name + " 可能传给 Grok，请确认公网传输", { field: field.name, requiresPublicTransfer: true });
      const converted = [];
      for (const entry of entries) {
        if (!isMediaReference(entry)) { converted.push(entry); continue; }
        const file = await this.access.read(entry, field.name, field.type, agentId, publish);
        const saved = await this.files.upload(Readable.from(file.content), file.name, file.mediaType, agentId, "runtime", undefined, publish);
        uploaded.push(saved.assetId);
        checks.push(() => this.access.describe(entry, field.name, field.type, agentId, publish));
        converted.push(saved);
      }
      result[field.name] = Array.isArray(value) ? converted : converted[0];
    }
    return result;
  }

  async describe(reference: string, field: WorkflowField, agentId: string) {
    const file = await this.access.describe(reference, field.name, field.type, agentId);
    return { assetId: file.id, name: file.name, mediaType: file.mediaType, size: file.size };
  }

  async discard(ids: string[]) {
    await Promise.all(ids.map(id => this.files.remove(id)));
  }
}
