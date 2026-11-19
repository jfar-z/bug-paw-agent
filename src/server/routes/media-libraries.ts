import type { FastifyInstance } from "fastify";
import type { MediaCategory, MediaDeleteConfirmation, MediaLibraryUpdate, MediaRename } from "../../shared/media-library-contracts";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import { MediaRepository, mediaName } from "../media-library/media-repository";
import { MediaStorage } from "../media-library/media-storage";
import { sendResolvedFile } from "./attachments";
import type { AuthService } from "./auth";
import { requireAuthentication } from "./protected";

type LibraryParams = { libraryId: string };
type FileParams = LibraryParams & { fileId: string };

/** 对元数据、原件和封面统一执行工作台会话校验。 */
export function registerMediaLibraryRoutes(
  app: FastifyInstance,
  auth: AuthService,
  repo: MediaRepository,
  storage: MediaStorage,
) {
  return app.register(async (scoped) => {
    scoped.addHook("onRequest", async (request, reply) => {
      reply.header("Cache-Control", "private, no-store");
      if (!(await requireAuthentication(request, reply, auth))) return reply;
    });
    const root = "/api/media-libraries";
    const library = root + "/:libraryId";
    const files = library + "/files";
    const file = files + "/:fileId";

    scoped.get(root, async () => ({ libraries: repo.list() }));
    scoped.post<{ Body: { name: string } }>(root, async (req, reply) =>
      reply.code(201).send(repo.create(req.body?.name)),
    );
    scoped.get<{ Params: LibraryParams }>(library, async (req) => repo.library(req.params.libraryId));
    scoped.patch<{ Params: LibraryParams; Body: MediaLibraryUpdate }>(library, async (req) =>
      repo.updateLibrary(req.params.libraryId, req.body?.name, req.body?.revision, req.body?.note),
    );
    scoped.delete<{ Params: LibraryParams; Body: MediaDeleteConfirmation }>(library, async (req, reply) => {
      const ids = repo.removeLibrary(req.params.libraryId, req.body ?? {});
      for (const id of ids) await storage.discard(id);
      return reply.code(204).send();
    });
    scoped.get<{ Params: LibraryParams; Querystring: { category?: MediaCategory } }>(files, async (req) => {
      const category = req.query.category;
      if (category !== undefined && !["image", "video", "audio"].includes(category))
        throw new DomainError("VALIDATION_FAILED", "文件类别须为 image、video 或 audio");
      return { files: repo.listFiles(req.params.libraryId, category) };
    });
    scoped.get<{ Params: LibraryParams; Querystring: { name: string; excludeFileId?: string } }>(
      library + "/name-check",
      async (req) => {
        repo.library(req.params.libraryId);
        return {
          available: repo.available(
            req.params.libraryId,
            mediaName(req.query.name, true),
            req.query.excludeFileId,
          ),
        };
      },
    );
    let activeUploads = 0;
    scoped.post<{ Params: LibraryParams }>(files, async (req, reply) => {
      repo.library(req.params.libraryId);
      if (!req.isMultipart()) throw new DomainError("VALIDATION_FAILED", "请以 multipart/form-data 上传媒体文件");
      if (activeUploads >= SYSTEM_LIMITS.concurrentMediaUploads)
        throw new DomainError("MEDIA_UPLOAD_BUSY", "同时处理的媒体上传已达上限，请稍后重新提交");
      activeUploads++;
      try {
        let upload: { name: string; data: Buffer } | undefined;
        try {
          for await (const part of req.parts({
            limits: { files: 1, fields: 0, fileSize: SYSTEM_LIMITS.mediaUploadBytes },
          })) {
            if (part.type !== "file" || part.fieldname !== "file")
              throw new DomainError("VALIDATION_FAILED", "请使用 file 字段上传一个媒体文件");
            upload = { name: part.filename, data: await part.toBuffer() };
          }
        } catch (cause) {
          if (cause instanceof app.multipartErrors.RequestFileTooLargeError)
            throw new DomainError("MEDIA_UPLOAD_LIMIT", "每个媒体文件最大 50 MiB");
          if (cause instanceof DomainError) throw cause;
          throw new DomainError(
            "VALIDATION_FAILED",
            "读取媒体上传表单失败，请检查连接并仅提交一个 file 字段",
            undefined,
            { cause },
          );
        }
        if (!upload || !req.raw.complete) throw new DomainError("VALIDATION_FAILED", "媒体上传未完整接收");
        return reply.code(201).send(await storage.save(req.params.libraryId, upload.name, upload.data));
      } finally {
        activeUploads--;
      }
    });
    scoped.get<{ Params: FileParams }>(file, async (req) => repo.file(req.params.libraryId, req.params.fileId));
    scoped.patch<{ Params: FileParams; Body: MediaRename }>(file, async (req) =>
      repo.renameFile(req.params.libraryId, req.params.fileId, req.body?.name, req.body?.revision),
    );
    scoped.delete<{ Params: FileParams; Body: { revision: number } }>(file, async (req, reply) => {
      repo.removeFile(req.params.libraryId, req.params.fileId, req.body?.revision);
      await storage.discard(req.params.fileId);
      return reply.code(204).send();
    });
    for (const representation of ["content", "thumbnail"] as const) {
      scoped.get<{ Params: FileParams }>(file + "/" + representation, async (req, reply) => {
        const item = repo.file(req.params.libraryId, req.params.fileId);
        return sendResolvedFile(req, reply, await storage.resolve(item, representation === "thumbnail"), false);
      });
    }
  });
}
