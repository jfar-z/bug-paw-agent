// @vitest-environment node

import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

import { AIGC_TASK_BULK_DELETE_LIMIT, type AigcTaskRecord } from "../../shared/aigc-contracts";
import { registerAigcChannelRoutes } from "./aigc-channels";
import { registerAigcRoutes } from "./aigc";
import { VersionConflictError } from "../configuration/versioned-json-store";
import { registerApiV1Namespace } from "../http/api-versioning";
import { DomainError } from "../core/errors";

const roots: string[] = [];

describe("AIGC 运行态渠道路由", () => {
  it("返回执行状态但不暴露渠道服务地址", async () => {
    const app = Fastify();
    registerAigcChannelRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      management: {
        document: async () => ({
          revision: "r1",
          credentialRevision: "c1",
          channelTemplates: [],
          credentials: [],
          channels: [{
            id: "private-comfy",
            name: "内网 ComfyUI",
            type: "comfyui",
            baseUrl: "http://192.168.1.20:8188",
            enabled: true,
            hasApiKey: false,
          }],
        }),
      } as never,
      validation: {} as never,
      credentials: {} as never,
    });
    await app.ready();

    const response = await app.inject({ method: "GET", url: "/api/aigc/runtime-channels" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      channels: [{ id: "private-comfy", name: "内网 ComfyUI", type: "comfyui", enabled: true, hasApiKey: false }],
    });
    expect(response.body).not.toContain("192.168.1.20");
    expect(response.headers["cache-control"]).toBe("no-store");
    await app.close();
  });
});

describe("AIGC 产物路由", () => {
  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("批量创作与再次运行草稿均要求工作台登录", async () => {
    const app = Fastify();
    registerApiV1Namespace(app);
    registerAigcRoutes(app, { authService: { isAuthenticated: async () => false } as never,
      workflows: {} as never, interfaces: {} as never, tasks: {} as never, assets: {} as never,
      publicFiles: {} as never, comfyuiInputs: {} as never });
    const responses = await Promise.all([
      app.inject({ method: "POST", url: "/api/v1/aigc/tasks/batch", payload: {} }),
      app.inject({ method: "GET", url: "/api/v1/aigc/tasks/example/rerun-draft" }),
    ]);
    for (const response of responses) {
      expect(response.statusCode).toBe(401);
      expect(response.json().error).toMatchObject({ code: "AUTH_REQUIRED", requestId: expect.any(String) });
    }
    await app.close();
  });

  it.each([true, false])("任务诊断沿用登录权限：%s", async (authenticated) => {
    const diagnostics = { request: { method: "POST", endpoint: "images/generations", body: { model: "image-model", prompt: "猫" } }, response: { endpoint: "images/generations", status: 400, body: '{"error":{"code":"bad_size"}}', truncated: false } };
    const get = vi.fn(async () => ({ id: "task-1", status: "failed", diagnostics }));
    const app = Fastify();
    registerApiV1Namespace(app);
    registerAigcRoutes(app, { authService: { isAuthenticated: async () => authenticated } as never,
      workflows: {} as never, interfaces: {} as never, tasks: { get } as never,
      assets: {} as never, publicFiles: {} as never, comfyuiInputs: {} as never });
    const response = await app.inject({ method: "GET", url: "/api/v1/aigc/tasks/task-1" });
    expect(response.statusCode).toBe(authenticated ? 200 : 401);
    if (authenticated) expect(response.json().diagnostics).toEqual(diagnostics);
    else expect(get).not.toHaveBeenCalled();
    await app.close();
  });

it("提供产物分页、任务删除与图片缩略图接口", async () => {
    const root = await mkdtemp(join(tmpdir(), "bugpaw-aigc-thumbnail-"));
    roots.push(root);
    const thumbnailPath = join(root, "thumbnail.webp");
    await writeFile(thumbnailPath, Buffer.from("thumbnail", "utf8"));
    const task: AigcTaskRecord = {
      id: "task-1", interfaceId: "interface-1", interfaceName: "ComfyUI", channelId: "channel-1", status: "succeeded", inputs: {},
      assets: [{ id: "asset-1", name: "成品.png", mediaType: "image/png", size: 13, createdAt: "2026-08-17T00:00:00.000Z" }],
      createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z",
    };
    const removed: string[] = [];
    const removedBatches: string[][] = [];
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {} as never,
      interfaces: {} as never,
      tasks: {
        get: async () => task,
        listOutputs: async () => ({ items: [], counts: { image: 1, video: 0, audio: 0, other: 0 }, page: 1, pageSize: 24, total: 1, totalPages: 1 }),
        remove: async (id: string) => { removed.push(id); return task; },
        removeMany: async (ids: string[]) => { removedBatches.push(ids); return { removedIds: ids }; },
      } as never,
      assets: { resolveThumbnailPath: async () => thumbnailPath } as never,
      publicFiles: {} as never,
      comfyuiInputs: {} as never,
    });
    await app.ready();

    const page = await app.inject({ method: "GET", url: "/api/aigc/outputs?kind=image&sort=desc&page=1&pageSize=24" });
    expect(page.statusCode).toBe(200);
    expect(page.json()).toMatchObject({ counts: { image: 1 }, page: 1 });
    const thumbnail = await app.inject({ method: "GET", url: "/api/aigc/tasks/task-1/assets/asset-1/thumbnail" });
    expect(thumbnail.statusCode).toBe(200);
    expect(thumbnail.headers["content-type"]).toContain("image/webp");
    expect(thumbnail.headers["cache-control"]).toContain("immutable");
    expect((await app.inject({ method: "DELETE", url: "/api/aigc/tasks/task-1" })).statusCode).toBe(204);
    expect(removed).toEqual(["task-1"]);
    const bulkDelete = await app.inject({ method: "DELETE", url: "/api/aigc/tasks", payload: { ids: ["task-1", "task-2"] } });
    expect(bulkDelete.statusCode).toBe(200);
    expect(bulkDelete.json()).toEqual({ removedIds: ["task-1", "task-2"] });
    expect(removedBatches).toEqual([["task-1", "task-2"]]);
    expect((await app.inject({ method: "DELETE", url: "/api/aigc/tasks", payload: { ids: [] } })).statusCode).toBe(400);
    const oversized = await app.inject({
      method: "DELETE",
      url: "/api/aigc/tasks",
      payload: { ids: Array.from({ length: AIGC_TASK_BULK_DELETE_LIMIT + 1 }, (_, index) => `task-${index}`) },
    });
    expect(oversized.statusCode).toBe(400);
    expect(oversized.json()).toMatchObject({
      error: { message: `AIGC 批量删除任务参数无效，单次最多删除 ${AIGC_TASK_BULK_DELETE_LIMIT} 个任务` },
    });
    expect(removedBatches).toEqual([["task-1", "task-2"]]);
    await app.close();
  });
});

describe("AIGC 工作流节点元数据路由", () => {
  it("同步节点定义并返回新的配置版本和摘要", async () => {
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {
        metadataNodeClasses: async () => ["KSampler"],
        syncNodeMetadata: async () => ({ revision: "r2", workflow: { id: "workflow-1", nodeMetadataSyncedAt: "2026-08-20T08:00:00.000Z" } }),
      } as never,
      interfaces: {} as never,
      tasks: {} as never,
      assets: {} as never,
      publicFiles: {} as never,
      comfyuiInputs: {
        getNodeMetadata: async () => ({
          metadata: { KSampler: { fields: {} } },
          syncedNodeClasses: ["KSampler"],
          missingNodeClasses: [],
          syncedAt: "2026-08-20T08:00:00.000Z",
        }),
      } as never,
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/aigc/workflows/workflow-1/sync-node-metadata",
      payload: { channelId: "comfy", revision: "r1" },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ revision: "r2", syncedNodeClasses: ["KSampler"], workflow: { id: "workflow-1" } });
    await app.close();
  });

  it("替换原始工作流并返回新的配置版本", async () => {
    const replace = vi.fn(async () => ({
      revision: "r2",
      workflow: { id: "workflow-1", fileName: "new.json", inputMappings: [], outputMappings: [] },
    }));
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: { replace } as never,
      interfaces: {} as never,
      tasks: {} as never,
      assets: {} as never,
      publicFiles: {} as never,
      comfyuiInputs: {} as never,
    });
    await app.ready();

    const workflowJson = { "1": { class_type: "KSampler", inputs: { steps: 20 } } };
    const response = await app.inject({
      method: "POST",
      url: "/api/aigc/workflows/workflow-1/replace",
      payload: { revision: "r1", fileName: "new.json", workflowJson, confirmationToken: "checked" },
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ revision: "r2", workflow: { id: "workflow-1", fileName: "new.json" } });
    expect(replace).toHaveBeenCalledWith("workflow-1", { fileName: "new.json", workflowJson, confirmationToken: "checked" }, "r1");
    await app.close();
  });

  it.each(["正常检查", "版本冲突", "未确认", "非法摘要", "未认证"])("替换检查与确认接口：%s", async (scenario) => {
    const preview = { revision: "r1", confirmationToken: "checked", removedMappings: [
      { kind: "input", id: "steps", name: "步数", nodeId: "1", field: "inputs.steps", reason: "映射字段不存在" },
    ] };
    const previewReplacement = vi.fn(async () => {
      if (scenario === "版本冲突") throw new VersionConflictError("r1", "r2");
      return preview;
    });
    const replace = vi.fn(async () => { throw new DomainError("VALIDATION_FAILED", "工作流替换尚未确认，请重新检查映射并确认后替换"); });
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => scenario !== "未认证" } as never,
      workflows: { previewReplacement, replace } as never, interfaces: {} as never, tasks: {} as never,
      assets: {} as never, publicFiles: {} as never, comfyuiInputs: {} as never,
    });
    const workflowJson = { "1": { class_type: "KSampler", inputs: { seed: 1 } } };
    const replacing = scenario === "未确认" || scenario === "非法摘要";
    const response = await app.inject({ method: "POST", url: `/api/aigc/workflows/workflow-1/${replacing ? "replace" : "replace-preview"}`,
      payload: { revision: "r1", fileName: "new.json", workflowJson, ...(scenario === "非法摘要" ? { confirmationToken: true } : {}) } });
    if (scenario === "正常检查") {
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual(preview);
      expect(previewReplacement).toHaveBeenCalledWith("workflow-1", { fileName: "new.json", workflowJson }, "r1");
    } else {
      const code = scenario === "版本冲突" ? "VERSION_CONFLICT" : scenario === "未认证" ? "AUTH_REQUIRED" : "VALIDATION_FAILED";
      expect(response.statusCode).toBe(scenario === "版本冲突" ? 409 : scenario === "未认证" ? 401 : 400);
      expect(response.json()).toMatchObject({ error: { code, requestId: expect.any(String), message: expect.any(String) } });
      if (scenario === "未确认") expect(response.json().error.message).toContain("尚未确认");
      if (scenario === "非法摘要" || scenario === "未认证") {
        expect(previewReplacement).not.toHaveBeenCalled();
        expect(replace).not.toHaveBeenCalled();
      }
    }
    if (!replacing) expect(replace).not.toHaveBeenCalled();
    await app.close();
  });
});

describe("ComfyUI input 媒体代理路由", () => {
  it("仅返回同源媒体内容和安全响应头", async () => {
    const app = Fastify();
    const requested: Array<{ channelId: string; filename: string; range?: string }> = [];
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {} as never,
      interfaces: {} as never,
      tasks: {} as never,
      assets: {} as never,
      publicFiles: {} as never,
      comfyuiInputs: {
        content: async (channelId: string, file: { filename: string }, range?: string) => {
          requested.push({ channelId, filename: file.filename, range });
          return {
            stream: Readable.from([Buffer.from("video")]),
            status: 206,
            mediaType: "video/mp4",
            contentLength: "5",
            acceptRanges: "bytes",
            contentRange: "bytes 0-4/5",
          };
        },
      } as never,
    });
    await app.ready();

    const response = await app.inject({
      method: "GET",
      url: "/api/aigc/comfyui-input-files/content?channelId=private&filename=clip.mp4&type=input",
      headers: { range: "bytes=0-4" },
    });
    expect(response.statusCode).toBe(206);
    expect(response.body).toBe("video");
    expect(response.headers).toMatchObject({
      "content-type": "video/mp4",
      "content-length": "5",
      "accept-ranges": "bytes",
      "content-range": "bytes 0-4/5",
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    });
    expect(JSON.stringify(response.headers)).not.toContain("192.168.");
    expect(response.headers.location).toBeUndefined();
    expect(response.headers.server).toBeUndefined();
    expect(requested).toEqual([{ channelId: "private", filename: "clip.mp4", range: "bytes=0-4" }]);
    await app.close();
  });

});

describe("AIGC 轻剪辑路由", () => {
  it("提供工程 CRUD、导出状态与取消接口", async () => {
    const project = {
      id: "project-1", revision: "revision-1", name: "视频工程", kind: "video" as const, clips: [],
      createdAt: "2026-08-21T00:00:00.000Z", updatedAt: "2026-08-21T00:00:00.000Z",
    };
    const job = {
      id: "render-1", projectId: project.id, projectName: project.name, kind: project.kind,
      status: "queued" as const, progress: 0, queuePosition: 1, createdAt: "2026-08-21T00:00:00.000Z",
    };
    const remove = vi.fn(async () => undefined);
    const mediaProjects = {
      list: async () => ({ projects: [project] }),
      create: async () => project,
      get: async (id: string) => id === project.id ? project : undefined,
      update: async () => ({ ...project, revision: "revision-2", name: "成片" }),
      remove,
      render: async () => job,
      getRender: async (id: string) => id === job.id ? job : undefined,
      cancelRender: async () => ({ ...job, status: "cancelled" as const }),
      resolveRenderPath: async () => undefined,
    };
    const app = Fastify();
    registerAigcRoutes(app, {
      authService: { isAuthenticated: async () => true } as never,
      workflows: {} as never,
      interfaces: {} as never,
      tasks: {} as never,
      assets: {} as never,
      publicFiles: {} as never,
      comfyuiInputs: {} as never,
      mediaProjects: mediaProjects as never,
    });
    await app.ready();

    expect((await app.inject({ method: "GET", url: "/api/aigc/media-projects" })).json()).toMatchObject({ projects: [{ id: project.id }] });
    expect((await app.inject({ method: "POST", url: "/api/aigc/media-projects", payload: { kind: "video" } })).statusCode).toBe(201);
    expect((await app.inject({ method: "GET", url: `/api/aigc/media-projects/${project.id}` })).statusCode).toBe(200);
    const update = await app.inject({
      method: "PATCH", url: `/api/aigc/media-projects/${project.id}`,
      payload: { revision: project.revision, name: "成片", clips: [] },
    });
    expect(update.statusCode).toBe(200);
    expect(update.json()).toMatchObject({ revision: "revision-2", name: "成片" });
    expect((await app.inject({ method: "POST", url: `/api/aigc/media-projects/${project.id}/render` })).statusCode).toBe(202);
    expect((await app.inject({ method: "GET", url: `/api/aigc/media-renders/${job.id}` })).json()).toMatchObject({ status: "queued", queuePosition: 1 });
    expect((await app.inject({ method: "POST", url: `/api/aigc/media-renders/${job.id}/cancel` })).json()).toMatchObject({ status: "cancelled" });
    expect((await app.inject({ method: "DELETE", url: `/api/aigc/media-projects/${project.id}` })).statusCode).toBe(204);
    expect(remove).toHaveBeenCalledWith(project.id);
    await app.close();
  });
});
