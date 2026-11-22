import type { WorkflowDefinition, WorkflowField } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
import { isMediaReference, type MediaAccess } from "../media-library/media-access";
import type { WorkflowFiles } from "../workflows/workflow-files";
import { checkField, invalid } from "../workflows/workflow-validation";
import type { TemplateSnapshot } from "./run-template-repository";

/** 逐项复核引用，数组中某个文件失效时可继续恢复其余项。 */
export async function projectWorkflowTemplate(definition: WorkflowDefinition, files: WorkflowFiles, media: MediaAccess,
  saved: Record<string, unknown>, previous?: TemplateSnapshot) {
  const fields = definition.nodes.find(node => node.kind === "input")!.outputs;
  const inputs: Record<string, unknown> = Object.create(null);
  const types = Object.fromEntries(fields.map(field => [field.name, field.type + (field.multiple ? "[]" : "")]));
  const issues: {field: string; message: string}[] = [];
  function report(field: string, error: unknown) {
    if (!(error instanceof DomainError) || !["VALIDATION_FAILED","INVALID_ATTACHMENT","NOT_FOUND","FORBIDDEN"].includes(error.code)) throw error;
    issues.push({ field, message: error.message });
  }
  async function project(field: WorkflowField, value: unknown) {
    if (field.multiple && value != null) invalid("参数 " + field.name + " 必须为数组");
    if (value != null && ["image","video","audio","file"].includes(field.type)) {
      if (isMediaReference(value)) {
        await media.describe(value, field.name, field.type);
        return value;
      }
      value = (await files.resolve(value)).file;
    }
    checkField(field, value);
    return value;
  }
  for (const [name, value] of Object.entries(saved)) {
    try {
      const field = fields.find(item => item.name === name);
      if (!field) invalid("当前工作流已无参数 " + name);
      const type = types[name];
      if (previous && previous.types[name] !== type) invalid("参数 " + name + " 的类型已变化");
      if (field.multiple && Array.isArray(value)) {
        if (value.length > 100) invalid("参数 " + name + " 超出 100 项");
        const accepted: unknown[] = [];
        for (const entry of value) {
          try {
            accepted.push(await project({ ...field, multiple: false, required: true }, entry));
          } catch (error) {
            report(name, error);
          }
        }
        if (accepted.length || !value.length) inputs[name] = accepted;
      } else {
        inputs[name] = await project(field, value);
      }
    } catch (error) {
      report(name, error);
    }
  }
  return { targetName: definition.name, snapshot: { inputs, types }, issues };
}
