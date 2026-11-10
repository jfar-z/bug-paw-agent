import { WorkflowFileManager } from "../workflows/workflow-file-manager";
import { streamWorkflowScriptAssist } from "./workflow-script-assist-stream";
import { stat } from "node:fs/promises";
import type { FastifyInstance } from "fastify";
import type {
  WorkflowDraft,
  WorkflowSemaphoreInput,
  WorkflowScriptAssistRequest,
} from "../../shared/workflow-contracts";
import { sendResolvedFile } from "./attachments";
import type { AuthService } from "./auth";
import { requireAuthentication } from "./protected";
import type { WorkflowService } from "../workflows/workflow-service";
import type { WorkflowNodeExecutor } from "../workflows/workflow-executor";
import type { WorkflowFiles } from "../workflows/workflow-files";
import { invalid, record } from "../workflows/workflow-validation";

/** 工作流管理入口全部受现有登录、Origin 与版本化 API 保护。 */
export function registerWorkflowRoutes(
  app: FastifyInstance,
  deps: {
    authService: AuthService;
    service: WorkflowService;
    executor: WorkflowNodeExecutor;
    files: WorkflowFiles;
  },
): void {
  const { service } = deps;
  const manager = new WorkflowFileManager(deps.files, service);
  app.register(async (router) => {
    router.addHook("preHandler", async (request, reply) => {
      await requireAuthentication(request, reply, deps.authService);
      reply.header("Cache-Control", "no-store");
    });
    router.get("/api/workflow-semaphores", async () => ({ semaphores: service.semaphores.list() }));
    router.post<{ Body: WorkflowSemaphoreInput & { revision?: number } }>("/api/workflow-semaphores", async (request) => service.saveSemaphore(request.body, request.body?.revision));
    router.delete<{ Params: { code: string }; Body: { revision: number } }>("/api/workflow-semaphores/:code", async (request, reply) => {
      await service.removeSemaphore(request.params.code, request.body?.revision);
      return reply.code(204).send();
    });
    router.get("/api/workflows", async () => ({
      workflows: await service.list(),
    }));
    router.get("/api/workflows/catalog", async () => ({
      ...await deps.executor.catalog(),
      workflows: service.catalogWorkflows(),
      semaphores: service.semaphores.list().map(({ code, name, limit, revision }) => ({ code, name, limit, revision })),
    }));
    router.post<{ Body: WorkflowScriptAssistRequest }>(
      "/api/workflows/script-assist",
      async (request, reply) => {
        const controller = new AbortController();
        const disconnected = () => {
          if (!reply.raw.writableEnded) controller.abort();
        };
        reply.raw.on("close", disconnected);
        try {
          if (request.headers.accept?.includes("text/event-stream")) {
            await streamWorkflowScriptAssist(request, reply, deps.executor, controller);
            return reply;
          }
          return await deps.executor.assistScript(
            request.body,
            controller.signal,
          );
        } finally {
          reply.raw.off("close", disconnected);
        }
      },
    );
    router.post<{ Body: WorkflowDraft }>(
      "/api/workflows",
      async (request, reply) =>
        reply.code(201).send(await service.save(request.body)),
    );
    router.get<{ Params: { id: string } }>(
      "/api/workflows/:id",
      async (request) => service.get(request.params.id),
    );
    router.put<{
      Params: { id: string };
      Body: WorkflowDraft & { revision: number };
    }>("/api/workflows/:id", async (request) =>
      service.save(request.body, request.params.id, request.body?.revision),
    );
    router.delete<{ Params: { id: string }; Body: { revision: number } }>(
      "/api/workflows/:id",
      async (request, reply) => {
        await service.remove(request.params.id, request.body?.revision);
        return reply.code(204).send();
      },
    );
    router.post<{ Body: WorkflowDraft & { id?: string } }>(
      "/api/workflows/validate",
      async (request) => {
        service.validate(request.body, request.body?.id);
        return { valid: true };
      },
    );
    router.post<{
      Params: { id: string };
      Body: { inputs: Record<string, unknown>; requestKey: string };
    }>("/api/workflows/:id/run", async (request, reply) => {
      if (!record(request.body)) invalid("工作流运行请求必须是对象");
      return reply
        .code(202)
        .send(
          await service.start(
            request.params.id,
            request.body.inputs,
            request.body.requestKey,
          ),
        );
    });
    router.get("/api/workflow-runs", async () => ({
      runs: service
        .listRuns()
        .slice(0, 200)
        .map((r) => ({
          id: r.id,
          workflowId: r.workflowId,
          name: r.definition.name,
          status: r.status,
          queueReason: r.queueReason,
          createdAt: r.createdAt,
          finishedAt: r.finishedAt,
          error: r.error,
        })),
    }));
    router.get<{ Params: { id: string } }>(
      "/api/workflow-runs/:id",
      async (request) => deps.files.annotateDeleted(service.getRun(request.params.id)),
    );
    router.post<{ Params: { id: string } }>(
      "/api/workflow-runs/:id/cancel",
      async (request) => service.cancel(request.params.id),
    );
    router.get<{ Querystring: Record<string, string> }>("/api/workflow-files", async (request) => manager.list(request.query));
    router.post<{ Body: { directory: string } }>("/api/workflow-files/clear-directory", async (request) => manager.clearDirectory(request.body?.directory));
    router.delete<{ Body: { ids: string[] } }>("/api/workflow-files", async (request, reply) => {
      await manager.remove(request.body?.ids);
      return reply.code(204).send();
    });
    router.get<{ Params: { id: string } }>("/api/workflow-files/:id/text", async (request) => deps.files.text(request.params.id));
    router.post<{ Querystring: { directory?: string } }>("/api/workflow-files", async (request) => {
      const directory = request.query.directory ?? "runtime";
      if (directory !== "constants" && directory !== "runtime") invalid("上传目录必须为运行文件或文件常量");
      const file = await request.file();
      if (!file) invalid("请选择工作流输入文件");
      return deps.files.upload(file.file, file.filename, file.mimetype, undefined, directory);
    });
    router.get<{ Params: { id: string }; Querystring: { preview?: string } }>(
      "/api/workflow-files/:id",
      async (request, reply) => {
        const { file, path } = await deps.files.resolve({
          assetId: request.params.id,
        });
        const info = await stat(path);
        // 仅媒体支持内联预览，HTML 等其他文件仍以附件交付。
        const preview =
          request.query.preview === "1" &&
          /^(image|video|audio)\//.test(file.mediaType);
        return sendResolvedFile(
          request,
          reply,
          {
            ...file,
            path: file.assetId,
            absolutePath: path,
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
          },
          !preview,
        );
      },
    );
  });
}
