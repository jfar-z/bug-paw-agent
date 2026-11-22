import { readRerunDraft, submitManualBatch } from "../aigc/aigc-manual-creation";
import { DomainError } from "../core/errors";
import { statusForDomainError } from "../http/error-handler";
import type { MediaAccess } from "../media-library/media-access";
import { submitMediaInputs } from "../media-library/aigc-media-inputs";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import type { FastifyInstance, FastifyRequest } from "fastify";

import type {
  AigcMediaProjectCreateInput,
  AigcMediaProjectUpdateInput,
} from "../../shared/aigc-media-editor-contracts";
import type {
  AigcOutputKind,
  AigcPublicDirectoryEntry,
  AigcPublicFileRecord,
  AigcInterfaceInput,
  AigcPublicFileSummary,
  AigcRunRequest,
  AigcBatchRequest,
  AigcWorkflowCreateInput,
  AigcWorkflowReplaceInput,
  AigcWorkflowUpdateInput,
} from "../../shared/aigc-contracts";
import { AIGC_TASK_BULK_DELETE_LIMIT } from "../../shared/aigc-contracts";
import type { AigcAssetService } from "../aigc/aigc-asset-service";
import type { AigcComfyUiInputService } from "../aigc/aigc-comfyui-input-service";
import { AigcMediaProjectError, type AigcMediaProjectService } from "../aigc/aigc-media-project-service";
import type { AigcInterfaceService } from "../aigc/aigc-interface-service";
import { AigcPublicDirectoryError, type AigcPublicFileService } from "../aigc/aigc-public-file-service";
import type { AigcTaskService } from "../aigc/aigc-task-service";
import type { AigcWorkflowService } from "../aigc/aigc-workflow-service";
import { VersionConflictError } from "../configuration/versioned-json-store";
import type { AuthService } from "./auth";
import { sendApiError } from "./http";
import { requireAuthentication } from "./protected";

interface AigcRouteDependencies {
  authService: AuthService;
  workflows: AigcWorkflowService;
  interfaces: AigcInterfaceService;
  tasks: AigcTaskService;
  assets: AigcAssetService;
  publicFiles: AigcPublicFileService;
  comfyuiInputs: AigcComfyUiInputService;
  mediaAccess?: MediaAccess;
  publicOrigin?: string;
  mediaProjects?: AigcMediaProjectService;
}

/** 注册 AIGC 工作台的工作流、接口、任务与资产接口。 */
export function registerAigcRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  registerWorkflowRoutes(app, dependencies);
  registerInterfaceRoutes(app, dependencies);
  registerTaskRoutes(app, dependencies);
  registerAssetRoutes(app, dependencies);
  registerPublicFileRoutes(app, dependencies);
  registerComfyUiInputRoutes(app, dependencies);
  if (dependencies.mediaProjects) registerMediaProjectRoutes(app, dependencies.authService, dependencies.mediaProjects);
}

/** 注册轻剪辑工程、串行导出及结果文件路由。 */
function registerMediaProjectRoutes(app: FastifyInstance, authService: AuthService, projects: AigcMediaProjectService): void {
  app.get("/api/aigc/media-projects", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    return reply.send(await projects.list());
  });

  app.post("/api/aigc/media-projects", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || (body.kind !== "video" && body.kind !== "audio") || (body.name !== undefined && typeof body.name !== "string")) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "剪辑工程创建参数无效");
    }
    try {
      return reply.code(201).send(await projects.create(body as unknown as AigcMediaProjectCreateInput));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/media-projects/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    const project = await projects.get(request.params.id);
    return project ? reply.send(project) : sendApiError(reply, 404, "NOT_FOUND", "剪辑工程不存在");
  });

  app.patch<{ Params: { id: string } }>("/api/aigc/media-projects/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || typeof body.name !== "string" || !Array.isArray(body.clips)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "剪辑工程保存参数无效");
    }
    try {
      return reply.send(await projects.update(request.params.id, body as unknown as AigcMediaProjectUpdateInput));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/media-projects/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    try {
      await projects.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/aigc/media-projects/:id/render", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    try {
      return reply.code(202).send(await projects.render(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/media-renders/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    const job = await projects.getRender(request.params.id);
    return job ? reply.send(job) : sendApiError(reply, 404, "NOT_FOUND", "导出任务不存在");
  });

  app.post<{ Params: { id: string } }>("/api/aigc/media-renders/:id/cancel", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    try {
      return reply.send(await projects.cancelRender(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/api/aigc/media-renders/:id/output", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, authService))) return;
    const job = await projects.getRender(request.params.id);
    if (!job || job.status !== "succeeded" || !job.fileName || !job.mediaType) return sendApiError(reply, 404, "NOT_FOUND", "导出文件不存在");
    const path = await projects.resolveRenderPath(request.params.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "导出文件不存在");
    return sendAssetFile(reply, path, job.fileName, job.mediaType, request.query.download === "1");
  });
}

function registerWorkflowRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/workflows", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await dependencies.workflows.list());
  });

  app.post("/api/aigc/workflows", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.name !== "string" || typeof body.fileName !== "string" || !Array.isArray(body.inputMappings) || !Array.isArray(body.outputMappings)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "工作流导入格式无效");
    }
    try {
      const created = await dependencies.workflows.create(body as unknown as AigcWorkflowCreateInput);
      return reply.code(201).send(created.workflow);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/workflows/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await dependencies.workflows.get(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.patch<{ Params: { id: string } }>("/api/aigc/workflows/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || typeof body.name !== "string" || !Array.isArray(body.inputMappings) || !Array.isArray(body.outputMappings)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "工作流更新格式无效");
    }
    try {
      const updated = await dependencies.workflows.update(request.params.id, body as unknown as AigcWorkflowUpdateInput, body.revision);
      return reply.send(updated.workflow);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  // 预检查只返回兼容性结果，复用替换服务中的同一套校验，不写入工作流。
  app.post<{ Params: { id: string } }>("/api/aigc/workflows/:id/replace-preview", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || typeof body.fileName !== "string" || !("workflowJson" in body)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "工作流替换检查格式无效");
    }
    try {
      return reply.send(await dependencies.workflows.previewReplacement(request.params.id, {
        fileName: body.fileName, workflowJson: body.workflowJson,
      }, body.revision));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/aigc/workflows/:id/replace", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string" || typeof body.fileName !== "string" || !("workflowJson" in body)
      || (body.confirmationToken !== undefined && typeof body.confirmationToken !== "string")) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "工作流替换格式无效");
    }
    try {
      const input: AigcWorkflowReplaceInput = {
        fileName: body.fileName, workflowJson: body.workflowJson,
        ...(typeof body.confirmationToken === "string" ? { confirmationToken: body.confirmationToken } : {}),
      };
      return reply.send(await dependencies.workflows.replace(request.params.id, input, body.revision));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/aigc/workflows/:id/sync-node-metadata", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.channelId !== "string" || typeof body.revision !== "string") {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "请提供 ComfyUI 渠道和配置版本");
    }
    try {
      const nodeClasses = await dependencies.workflows.metadataNodeClasses(request.params.id);
      const synced = await dependencies.comfyuiInputs.getNodeMetadata(body.channelId, nodeClasses);
      const updated = await dependencies.workflows.syncNodeMetadata(
        request.params.id,
        synced.metadata,
        synced.syncedAt,
        body.revision,
      );
      return reply.send({
        revision: updated.revision,
        workflow: updated.workflow,
        syncedNodeClasses: synced.syncedNodeClasses,
        missingNodeClasses: synced.missingNodeClasses,
        syncedAt: synced.syncedAt,
      });
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/workflows/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    try {
      if (await dependencies.interfaces.isWorkflowInUse(request.params.id)) {
        return sendApiError(reply, 409, "VALIDATION_FAILED", "该工作流仍被 AIGC 接口引用");
      }
      await dependencies.workflows.remove(request.params.id, body.revision);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });
}

function registerInterfaceRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/interfaces", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await dependencies.interfaces.list());
  });

  app.post("/api/aigc/interfaces", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body) return sendApiError(reply, 400, "VALIDATION_FAILED", "接口配置格式无效");
    try {
      const created = await dependencies.interfaces.create(body as unknown as AigcInterfaceInput);
      return reply.code(201).send(created.item);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/interfaces/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const item = await dependencies.interfaces.get(request.params.id);
    if (!item) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 接口不存在");
    return reply.send(item);
  });

  app.patch<{ Params: { id: string } }>("/api/aigc/interfaces/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "接口更新格式无效");
    try {
      const updated = await dependencies.interfaces.update(request.params.id, body as unknown as AigcInterfaceInput, body.revision);
      return reply.send(updated.item);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/interfaces/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.revision !== "string") return sendApiError(reply, 400, "VALIDATION_FAILED", "缺少配置版本");
    try {
      await dependencies.interfaces.remove(request.params.id, body.revision);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });
}

function registerTaskRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    return reply.send(await dependencies.tasks.list());
  });

  app.delete<{ Body: { ids?: string[] } }>("/api/aigc/tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    const ids = body?.ids;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > AIGC_TASK_BULK_DELETE_LIMIT
      || ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== ids.length) {
      return sendApiError(
        reply,
        400,
        "VALIDATION_FAILED",
        `AIGC 批量删除任务参数无效，单次最多删除 ${AIGC_TASK_BULK_DELETE_LIMIT} 个任务`,
      );
    }
    try {
      return reply.send(await dependencies.tasks.removeMany(ids));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Querystring: { kind?: string; sort?: string; page?: string; pageSize?: string } }>("/api/aigc/outputs", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const kind = request.query.kind ?? "image";
    const sort = request.query.sort ?? "desc";
    const page = Number(request.query.page ?? "1");
    const pageSize = Number(request.query.pageSize ?? "24");
    if (!isOutputKind(kind) || (sort !== "asc" && sort !== "desc") || !Number.isInteger(page) || page < 1
      || !Number.isInteger(pageSize) || pageSize < 1 || pageSize > 96) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "AIGC 产物分页参数无效");
    }
    return reply.send(await dependencies.tasks.listOutputs({ kind, sort, page, pageSize }));
  });

  app.post("/api/aigc/tasks/batch", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = request.body;
    if (!isRecord(body) || typeof body.interfaceId !== "string" || !isRecord(body.inputs))
      return sendApiError(reply, 400, "VALIDATION_FAILED", "AIGC 批量创作参数格式无效");
    try {
      return reply.code(202).send(await submitManualBatch(body as unknown as AigcBatchRequest, dependencies));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/tasks/:id/rerun-draft", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await readRerunDraft(request.params.id, dependencies));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post("/api/aigc/tasks", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = isRecord(request.body) ? request.body : undefined;
    if (!body || typeof body.interfaceId !== "string" || !isRecord(body.inputs)) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "任务运行参数格式无效");
    }
    try {
      const input = body as unknown as AigcRunRequest;
      const task = dependencies.mediaAccess ? await submitMediaInputs(input, { ...dependencies, mediaAccess: dependencies.mediaAccess }) : await dependencies.tasks.createRun(input);
      return reply.code(202).send(task);
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/tasks/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const task = await dependencies.tasks.get(request.params.id);
    if (!task) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 任务不存在");
    return reply.send(task);
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/tasks/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      await dependencies.tasks.remove(request.params.id);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/aigc/tasks/:id/cancel", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await dependencies.tasks.cancel(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Params: { id: string } }>("/api/aigc/tasks/:id/retry", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      return reply.send(await dependencies.tasks.retry(request.params.id));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string; assetId: string }; Querystring: { download?: string } }>("/api/aigc/tasks/:id/assets/:assetId", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const task = await dependencies.tasks.get(request.params.id);
    if (!task) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 任务不存在");
    const asset = task.assets.find((candidate) => candidate.id === request.params.assetId);
    if (!asset) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 产物不存在");
    const path = await dependencies.assets.resolveOutputPath(task.id, asset.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 产物不存在");
    return sendAssetFile(reply, path, asset.name, asset.mediaType, request.query.download === "1");
  });

  app.get<{ Params: { id: string; assetId: string } }>("/api/aigc/tasks/:id/assets/:assetId/thumbnail", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const task = await dependencies.tasks.get(request.params.id);
    if (!task) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 任务不存在");
    const asset = task.assets.find((candidate) => candidate.id === request.params.assetId);
    if (!asset || !asset.mediaType.startsWith("image/")) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 图片产物不存在");
    const path = await dependencies.assets.resolveThumbnailPath(task.id, asset.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 图片产物不存在");
    return sendAssetFile(reply, path, `${asset.name}.webp`, "image/webp", false, "private, max-age=86400, immutable");
  });
}

function registerComfyUiInputRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get<{ Querystring: { channelId?: string; nodeClass?: string; field?: string } }>("/api/aigc/comfyui-input-files", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.channelId || !request.query.nodeClass || !request.query.field) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "请提供 ComfyUI 渠道、节点类型和字段路径");
    }
    try {
      const files = await dependencies.comfyuiInputs.list(request.query.channelId, request.query.nodeClass, request.query.field);
      return reply.send({ files });
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Querystring: { channelId?: string; filename?: string; subfolder?: string; type?: string } }>("/api/aigc/comfyui-input-files/content", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.channelId || !request.query.filename) {
      return sendApiError(reply, 400, "VALIDATION_FAILED", "请提供 ComfyUI 渠道和 input 文件名");
    }
    try {
      const content = await dependencies.comfyuiInputs.content(request.query.channelId, {
        filename: request.query.filename,
        ...(request.query.subfolder !== undefined ? { subfolder: request.query.subfolder } : {}),
        ...(request.query.type !== undefined ? { type: request.query.type } : {}),
      }, firstHeader(request.headers.range));
      reply.code(content.status);
      reply.header("Cache-Control", "private, no-store");
      reply.header("X-Content-Type-Options", "nosniff");
      reply.type(content.mediaType);
      if (content.contentLength) reply.header("Content-Length", content.contentLength);
      if (content.acceptRanges) reply.header("Accept-Ranges", content.acceptRanges);
      if (content.contentRange) reply.header("Content-Range", content.contentRange);
      return reply.send(content.stream);
    } catch {
      // 上游响应可能包含内网地址或实现细节，代理失败时统一返回脱敏错误。
      return sendApiError(reply, 502, "REQUEST_FAILED", "ComfyUI input 预览暂时不可用");
    }
  });
}

function registerAssetRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.post("/api/aigc/inputs", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传 AIGC 入参");
    try {
      const part = await request.file({ limits: { files: 1, fileSize: 200 * 1024 * 1024 } });
      if (!part) return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个 AIGC 入参文件");
      const saved = await dependencies.assets.saveInput(part.file, part.filename, part.mimetype);
      return reply.code(201).send({ asset: saved });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return sendApiError(reply, 413, "VALIDATION_FAILED", "AIGC 入参不能超过 200 MiB");
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string } }>("/api/aigc/inputs/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const path = await dependencies.assets.resolveInputPath(request.params.id);
    if (!path) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 入参不存在");
    return sendAssetFile(reply, path, request.params.id, "application/octet-stream", false);
  });
}

/** 注册公网可直接访问的 AIGC 公共文件上传、列表与下载接口。 */
function registerPublicFileRoutes(app: FastifyInstance, dependencies: AigcRouteDependencies): void {
  app.get("/api/aigc/public-files", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const files = await dependencies.publicFiles.list();
    return reply.send({
      files: files.map((file) => toPublicFileSummary(file, publicFileUrl(request, file.id))),
    });
  });

  app.post("/api/aigc/public-files", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传 AIGC 公共文件");
    try {
      const part = await request.file({ limits: { files: 1, fileSize: 200 * 1024 * 1024 } });
      if (!part) return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个 AIGC 公共文件");
      const file = await dependencies.publicFiles.save(part.file, part.filename, part.mimetype);
      return reply.code(201).send({ file: toPublicFileSummary(file, publicFileUrl(request, file.id)) });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return sendApiError(reply, 413, "VALIDATION_FAILED", "AIGC 公共文件不能超过 200 MiB");
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Params: { id: string } }>("/api/aigc/public-files/:id", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!await dependencies.publicFiles.remove(request.params.id)) {
      return sendApiError(reply, 404, "NOT_FOUND", "AIGC 公共文件不存在");
    }
    return reply.code(204).send();
  });

  app.get<{ Querystring: { directory?: string } }>("/api/aigc/public-directory/entries", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    try {
      const entries = await dependencies.publicFiles.listEntries(request.query.directory ?? "");
      return reply.send({ entries: entries.map((entry) => toPublicDirectoryEntry(request, entry)) });
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Querystring: { query?: string } }>("/api/aigc/public-directory/search", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.query?.trim()) return sendApiError(reply, 400, "INVALID_PATH", "请输入文件名关键字");
    try {
      const entries = await dependencies.publicFiles.searchEntries(request.query.query);
      return reply.send({ entries: entries.map((entry) => toPublicDirectoryEntry(request, entry)) });
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Querystring: { path?: string } }>("/api/aigc/public-directory/text", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.query.path) return sendApiError(reply, 400, "INVALID_PATH", "请提供文件路径");
    try {
      return reply.send(await dependencies.publicFiles.readText(request.query.path));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Body: { directory?: string; name?: string } }>("/api/aigc/public-directory/directories", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.body?.name) return sendApiError(reply, 400, "INVALID_PATH", "请提供目录名称");
    try {
      return reply.code(201).send(await dependencies.publicFiles.createDirectory(request.body.directory ?? "", request.body.name));
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.post<{ Querystring: { directory?: string } }>("/api/aigc/public-directory/uploads", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!request.isMultipart()) return sendApiError(reply, 400, "INVALID_MULTIPART", "请使用 multipart/form-data 上传 AIGC 公共文件");
    try {
      const uploads = async function* () {
        for await (const part of request.files({ limits: { fileSize: 200 * 1024 * 1024 } })) {
          yield { filename: part.filename, mediaType: part.mimetype, stream: part.file };
        }
      };
      const files = await dependencies.publicFiles.saveMany(uploads(), request.query.directory ?? "");
      if (!files.length) return sendApiError(reply, 400, "EMPTY_UPLOAD", "至少选择一个 AIGC 公共文件");
      return reply.code(201).send({ files: files.map((file) => toPublicFileSummary(file, publicFileUrl(request, file.id))) });
    } catch (error) {
      if (error instanceof app.multipartErrors.RequestFileTooLargeError) return sendApiError(reply, 413, "VALIDATION_FAILED", "AIGC 公共文件不能超过 200 MiB");
      return sendAigcError(reply, error);
    }
  });

  app.patch<{ Body: { operation?: string; path?: string; name?: string; targetDirectory?: string; createTargetDirectory?: boolean } }>("/api/aigc/public-directory/entries", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    const body = request.body;
    if (!body?.path) return sendApiError(reply, 400, "INVALID_PATH", "请提供文件路径");
    try {
      if (body.operation === "rename" && body.name) return reply.send(await dependencies.publicFiles.renameEntry(body.path, body.name));
      if (body.operation === "move" && body.targetDirectory !== undefined) {
        return reply.send(await dependencies.publicFiles.moveEntry(body.path, body.targetDirectory, body.createTargetDirectory === true));
      }
      return sendApiError(reply, 400, "INVALID_PATH", "文件操作参数无效");
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.delete<{ Body: { paths?: string[] } }>("/api/aigc/public-directory/entries", async (request, reply) => {
    if (!(await requireAuthentication(request, reply, dependencies.authService))) return;
    if (!Array.isArray(request.body?.paths) || !request.body.paths.length) return sendApiError(reply, 400, "INVALID_PATH", "至少选择一个文件或目录");
    try {
      await dependencies.publicFiles.removeEntries(request.body.paths);
      return reply.code(204).send();
    } catch (error) {
      return sendAigcError(reply, error);
    }
  });

  app.get<{ Params: { id: string }; Querystring: { download?: string } }>("/aigc-public/files/:id", async (request, reply) => {
    const [path, file] = await Promise.all([
      dependencies.publicFiles.resolvePath(request.params.id),
      dependencies.publicFiles.get(request.params.id),
    ]);
    if (!path || !file) return sendApiError(reply, 404, "NOT_FOUND", "AIGC 公共文件不存在");
    return sendAssetFile(reply, path, file.name, file.mediaType, request.query.download === "1");
  });
}

/** 给登录后的目录管理响应附加稳定公网 URL。 */
function toPublicDirectoryEntry(request: FastifyRequest, entry: AigcPublicDirectoryEntry): AigcPublicDirectoryEntry {
  return entry.id ? { ...entry, url: publicFileUrl(request, entry.id) } : entry;
}

/** 将公共文件记录映射为包含公网 URL 的浏览器摘要。 */
function toPublicFileSummary(file: AigcPublicFileRecord, url: string): AigcPublicFileSummary {
  return { ...file, url };
}

/** 根据请求 Host 与转发头生成公网可直接访问的文件 URL。 */
export function publicFileUrl(request: FastifyRequest, id: string): string {
  const forwardedProto = firstHeader(request.headers["x-forwarded-proto"]);
  const forwardedHost = firstHeader(request.headers["x-forwarded-host"]);
  const protocol = forwardedProto?.split(",", 1)[0].trim() || request.protocol;
  const host = forwardedHost?.split(",", 1)[0].trim() || request.headers.host || "localhost";
  return `${protocol}://${host}/aigc-public/files/${encodeURIComponent(id)}`;
}

/** 读取单值请求头。 */
function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/** 发送资产文件并固定安全响应头。 */
async function sendAssetFile(reply: Parameters<typeof sendApiError>[0], path: string, name: string, mediaType: string, download: boolean, cacheControl = "no-store") {
  const fileStat = await stat(path);
  reply.header("Cache-Control", cacheControl);
  reply.header("X-Content-Type-Options", "nosniff");
  reply.type(mediaType);
  if (download) reply.header("Content-Disposition", downloadContentDisposition(name));
  reply.header("Accept-Ranges", "bytes");
  const range = parseByteRange(reply.request.headers.range, fileStat.size);
  if (range === "invalid") {
    reply.header("Content-Range", `bytes */${fileStat.size}`);
    return reply.code(416).send();
  }
  if (range) {
    reply.header("Content-Range", `bytes ${range.start}-${range.end}/${fileStat.size}`);
    reply.header("Content-Length", String(range.end - range.start + 1));
    return reply.code(206).send(createReadStream(path, range));
  }
  reply.header("Content-Length", String(fileStat.size));
  return reply.send(createReadStream(path));
}

/** 只接受浏览器媒体元素使用的单一 bytes Range。 */
function parseByteRange(value: string | undefined, size: number): { start: number; end: number } | "invalid" | undefined {
  if (!value) return undefined;
  const match = value.match(/^bytes=(\d*)-(\d*)$/u);
  if (!match || (!match[1] && !match[2]) || size <= 0) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isInteger(suffix) || suffix <= 0) return "invalid";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(match[1]);
  const requestedEnd = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(requestedEnd) || start < 0 || start >= size || requestedEnd < start) return "invalid";
  return { start, end: Math.min(requestedEnd, size - 1) };
}

/** 兼容中文产物名，并阻止文件名向响应头注入控制字符。 */
function downloadContentDisposition(name: string): string {
  const normalized = name.replace(/[\r\n]/gu, "").trim() || "download";
  const asciiFallback = normalized.replace(/[^\x20-\x7E]/gu, "_").replace(/["\\]/gu, "_") || "download";
  const encoded = encodeURIComponent(normalized).replace(/[!'()*]/gu, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${asciiFallback}"; filename*=UTF-8''${encoded}`;
}

function sendAigcError(reply: Parameters<typeof sendApiError>[0], error: unknown) {
  if (error instanceof DomainError) return sendApiError(reply, statusForDomainError(error.code), error.code, error.message, error.details);
  if (error instanceof AigcMediaProjectError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : error.code === "QUEUE_FULL" ? 429 : 400;
    return sendApiError(reply, status, error.code === "CONFLICT" ? "CONFLICT" : error.code === "NOT_FOUND" ? "NOT_FOUND" : "VALIDATION_FAILED", error.message);
  }
  if (error instanceof VersionConflictError) return sendApiError(reply, 409, "VERSION_CONFLICT", error.message);
  if (error instanceof AigcPublicDirectoryError) {
    const status = error.code === "NOT_FOUND" ? 404 : error.code === "CONFLICT" ? 409 : error.code === "TEXT_PREVIEW_UNAVAILABLE" ? 422 : 400;
    return sendApiError(reply, status, error.code, error.message);
  }
  const message = error instanceof Error ? error.message : "AIGC 请求无效";
  if (message.includes("不存在")) return sendApiError(reply, 404, "NOT_FOUND", message);
  if (message.includes("未启用") || message.includes("已取消") || message.includes("引用")) return sendApiError(reply, 409, "VALIDATION_FAILED", message);
  return sendApiError(reply, 400, "VALIDATION_FAILED", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 校验产物页只接受四个固定媒体分组。 */
function isOutputKind(value: string): value is AigcOutputKind {
  return value === "image" || value === "video" || value === "audio" || value === "other";
}
