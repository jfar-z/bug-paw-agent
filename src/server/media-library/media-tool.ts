import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { MediaCategorySchema } from "../../shared/media-library-contracts";
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
