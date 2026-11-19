import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { Check } from "typebox/value";
import type { MediaDeleteConfirmations } from "./media-deletion";
import { MediaCategorySchema, MediaDeleteIdSchema } from "../../shared/media-library-contracts";
import { DomainError } from "../core/errors";
import { mediaReference, type MediaAccess } from "./media-access";

const nullable = Type.Union([Type.String({ minLength: 1 }), Type.Null()]);

/** 身份绑定自运行时，模型只传业务标识。 */
export function createMediaTool(agentId: string, access: MediaAccess) {
  return defineTool({
    name: "media_library", label: "媒体库",
    description: "libraries 查询授权库，files 列举可读文件，view 查看媒体，upload 上传工作区文件。无关字段传 null。reference 可直接用于 AIGC 或工作流媒体参数。",
    parameters: Type.Object({
      action: Type.Union([Type.Literal("libraries"), Type.Literal("files"), Type.Literal("view"), Type.Literal("upload")]),
      libraryId: nullable, fileId: nullable, category: Type.Union([MediaCategorySchema, Type.Null()]),
      path: nullable, name: nullable,
    }, { additionalProperties: false }),
    async execute(_id, { action, libraryId, fileId, category, path, name }) {
      let value: unknown;
      if (action === "libraries" && [libraryId, fileId, category, path, name].every(v => v === null))
        value = await access.libraries(agentId);
      else if (action === "files" && libraryId && fileId === null && path === null && name === null)
        value = await access.files(agentId, libraryId, category);
      else if (action === "upload" && libraryId && path && fileId === null && category === null) {
        const file = await access.upload(agentId, libraryId, path, name);
        value = { ...file, reference: mediaReference(libraryId, file.id) };
      } else if (action === "view" && libraryId && fileId && category === null && path === null && name === null) {
        const reference = mediaReference(libraryId, fileId);
        const file = await access.describe(reference, "fileId", "file", agentId);
        value = { ...file, reference };
        if (file.category === "image") {
          const preview = await access.read(reference, "fileId", "image", agentId, false, true);
          return { content: [{ type: "image", mimeType: "image/jpeg", data: preview.content.toString("base64") }], details: value };
        }
      } else throw new DomainError("VALIDATION_FAILED", "媒体库操作缺少必填字段或包含无关字段");
      return { content: [{ type: "text", text: JSON.stringify(value) }], details: value };
    },
  });
}

const deletionParameters = Type.Object({
  libraryId: MediaDeleteIdSchema,
  fileIds: Type.Array(MediaDeleteIdSchema, { minItems: 1, maxItems: 5000, uniqueItems: true }),
}, { additionalProperties: false });

/** 删除工具独立授权；确认清单仅由登录用户在当前对话中签收。 */
export function createMediaDeleteTool(agentId: string, sessionId: string, access: MediaAccess, confirmations: MediaDeleteConfirmations) {
  return defineTool({
    name: "media_library_delete", label: "删除媒体文件",
    description: "提交同一媒体库内明确指定的文件 ID。工作台将列出文件并等待用户确认永久删除。按名称请求时需在已有读取权限内先消歧。",
    promptSnippet: "请求用户确认并永久删除明确指定的媒体库文件",
    parameters: deletionParameters,
    executionMode: "sequential",
    async execute(_toolCallId, params, signal) {
      if (!Check(deletionParameters, params))
        throw new DomainError("VALIDATION_FAILED", "媒体删除需要一个库标识和互不重复的文件标识列表");
      const result = await access.requestDeletion(agentId, sessionId, params.libraryId, params.fileIds, confirmations, signal);
      // SDK 通过异常标记工具错误，保留完整逐项结果供对话展示。
      if (result.results.some(item => item.status === "failed" || item.status === "cleanup_failed"))
        throw new Error("媒体文件删除存在未完成项：" + JSON.stringify(result));
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  });
}
