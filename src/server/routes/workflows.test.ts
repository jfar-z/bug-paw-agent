import { createTestDatabase } from "../database/test-database";
// @vitest-environment node
import Fastify from "fastify";
import multipart from "@fastify/multipart";
import { WorkflowFiles } from "../workflows/workflow-files";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { registerWorkflowRoutes } from "./workflows";
import { WorkflowService } from "../workflows/workflow-service";
import { WorkflowRepository } from "../workflows/workflow-repository";
import { emptyWorkflow } from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";
/** 路由使用实际存储，确保管理、运行与产物入口都要求登录。 */
describe("工作流 HTTP API", () => {
  it("认证保护所有入口，登录后保存、运行、查询与删除保留历史", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-http-")),
      service = new WorkflowService(new WorkflowRepository(root, createTestDatabase()), {
        execute: async () => ({}),
      });
    await service.initialize();
    const app = Fastify();
    let authenticated = false;
    app.setErrorHandler((error, request, reply) => {
      if (error instanceof DomainError)
        return reply
          .code(error.code === "NOT_FOUND" ? 404 : 400)
          .send(error.toDocument(request.id));
      return reply.code(500).send({ message: "测试未预期异常" });
    });
    registerWorkflowRoutes(app, {
      authService: { isAuthenticated: async () => authenticated } as never,
      service,
      executor: {
        catalog: async () => ({ models: [], agents: [], interfaces: [] }),
      } as never,
      files: { annotateDeleted: async (value: unknown) => value } as never,
    });
    try {
      for (const [method, url] of [
        ["GET", "/api/workflow-semaphores"],
        ["POST", "/api/workflow-semaphores"],
        ["DELETE", "/api/workflow-semaphores/gpu"],
        ["GET", "/api/workflows"],
        ["GET", "/api/workflows/catalog"],
        ["POST", "/api/workflows"],
        ["GET", "/api/workflows/unknown"],
        ["PUT", "/api/workflows/unknown"],
        ["DELETE", "/api/workflows/unknown"],
        ["POST", "/api/workflows/validate"],
        ["POST", "/api/workflows/script-assist"],
        ["POST", "/api/workflows/unknown/run"],
        ["GET", "/api/workflow-runs"],
        ["GET", "/api/workflow-runs/unknown"],
        ["POST", "/api/workflow-runs/unknown/cancel"],
        ["POST", "/api/workflow-files"],
        ["GET", "/api/workflow-files"],
        ["DELETE", "/api/workflow-files"],
        ["GET", "/api/workflow-files/unknown/text"],
        ["GET", "/api/workflow-files/unknown"],
      ] as const) {
        const r = await app.inject({ method, url });
        expect(r.statusCode, `${method} ${url}`).toBe(401);
      }
      authenticated = true;
      const semaphore = await app.inject({ method: "POST", url: "/api/workflow-semaphores", payload: { code: "gpu", name: "GPU", limit: 2 } });
      expect(semaphore.statusCode).toBe(200);
      const invalidSemaphore = await app.inject({ method: "POST", url: "/api/workflow-semaphores", payload: { code: "gpu", name: "GPU", limit: -1 } });
      expect(invalidSemaphore.statusCode).toBe(400);
      expect(invalidSemaphore.json().error).toMatchObject({ code: "VALIDATION_FAILED", requestId: expect.any(String), message: expect.stringContaining("正整数") });
      const semaphoreList = await app.inject({ method: "GET", url: "/api/workflow-semaphores" });
      expect(semaphoreList.headers["cache-control"]).toBe("no-store");
      expect(semaphoreList.json().semaphores[0]).toMatchObject({ code: "gpu", used: 0, available: 2 });
      const catalog = await app.inject({ method: "GET", url: "/api/workflows/catalog" });
      expect(catalog.json().semaphores).toEqual([{ code: "gpu", name: "GPU", limit: 2, revision: 1 }]);
      expect((await app.inject({ method: "DELETE", url: "/api/workflow-semaphores/gpu", payload: { revision: 1 } })).statusCode).toBe(204);
      const invalidBody = await app.inject({
        method: "POST", url: "/api/workflows/validate",
        headers: { "content-type": "application/json" }, payload: "null",
      });
      expect(invalidBody.statusCode).toBe(400);
      expect(invalidBody.json().error).toMatchObject({ code: "VALIDATION_FAILED", requestId: expect.any(String) });
      const saved = await app.inject({
        method: "POST",
        url: "/api/workflows",
        payload: emptyWorkflow(),
      });
      expect(saved.statusCode).toBe(201);
      expect(saved.headers["cache-control"]).toBe("no-store");
      const definition = saved.json();
      // 同一未声明映射在校验、新建和更新入口均返回可追踪的具体错误。
      const stale = emptyWorkflow();
      stale.nodes[1].outputs = [{ name: "story", type: "string" }];
      for (const [method, url, payload] of [
        ["POST", "/api/workflows/validate", stale],
        ["POST", "/api/workflows", stale],
        ["PUT", `/api/workflows/${definition.id}`, { ...stale, revision: definition.revision }],
      ] as const) {
        const rejected = await app.inject({ method, url, payload });
        expect(rejected.statusCode).toBe(400);
        expect(rejected.json().error).toMatchObject({
          code: "VALIDATION_FAILED",
          message: expect.stringContaining("输出绑定 result 未声明"),
          requestId: expect.any(String),
        });
      }
      const started = await app.inject({
        method: "POST",
        url: `/api/workflows/${definition.id}/run`,
        payload: { inputs: { prompt: "http" }, requestKey: "http-run" },
      });
      expect(started.statusCode).toBe(202);
      await service.wait(started.json().id);
      const detail = await app.inject(
        `/api/workflow-runs/${started.json().id}`,
      );
      expect(detail.json()).toMatchObject({
        status: "succeeded",
        outputs: { result: "http" },
      });
      const bad = await app.inject({
        method: "POST",
        url: "/api/workflows/validate",
        payload: { ...emptyWorkflow(), edges: [] },
      });
      expect(bad.statusCode).toBe(400);
      expect(bad.json().error).toMatchObject({
        code: "VALIDATION_FAILED",
        requestId: expect.any(String),
      });
      expect(
        (
          await app.inject({
            method: "DELETE",
            url: `/api/workflows/${definition.id}`,
            payload: { revision: definition.revision },
          })
        ).statusCode,
      ).toBe(204);
      expect(
        (await app.inject(`/api/workflow-runs/${started.json().id}`))
          .statusCode,
      ).toBe(200);
    } finally {
      await app.close();
      await service.close();
      await rm(root, { recursive: true, force: true });
    }
  });
  it("媒体预览支持 Range、默认下载和安全响应头，辅助接口沿用登录保护", async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-media-http-"));
    const path = join(root, "fixture.mp4");
    await writeFile(path, "0123456789", "utf8");
    const app = Fastify();
    let authenticated = true;
    let mediaType = "video/mp4";
    const assistScript = vi.fn(async () => ({ script: "return {};" }));
    registerWorkflowRoutes(app, {
      authService: { isAuthenticated: async () => authenticated } as never,
      service: {} as never,
      executor: { assistScript } as never,
      files: {
        resolve: async () => ({
          file: { assetId: "fixture", name: "产物.mp4", mediaType, size: 10 },
          path,
        }),
      } as never,
    });
    try {
      const preview = await app.inject({
        url: "/api/workflow-files/fixture?preview=1",
        headers: { range: "bytes=2-5" },
      });
      expect(preview.statusCode).toBe(206);
      expect(preview.body).toBe("2345");
      expect(preview.headers["content-range"]).toBe("bytes 2-5/10");
      expect(preview.headers["content-disposition"]).toBeUndefined();
      expect(preview.headers["cache-control"]).toBe("no-store");
      expect(preview.headers["x-content-type-options"]).toBe("nosniff");
      expect(preview.headers["x-bugpaw-file-path"]).toBe("fixture");
      const suffix = await app.inject({
        url: "/api/workflow-files/fixture?preview=1",
        headers: { range: "bytes=-3" },
      });
      expect(suffix.body).toBe("789");
      expect(
        (
          await app.inject({
            url: "/api/workflow-files/fixture?preview=1",
            headers: { range: "bytes=99-" },
          })
        ).statusCode,
      ).toBe(416);
      const download = await app.inject("/api/workflow-files/fixture");
      expect(download.headers["content-disposition"]).toContain("attachment;");
      expect(download.body).toBe("0123456789");
      mediaType = "image/svg+xml";
      expect(
        (await app.inject("/api/workflow-files/fixture?preview=1")).headers[
          "content-security-policy"
        ],
      ).toContain("sandbox");
      mediaType = "text/html";
      expect(
        (await app.inject("/api/workflow-files/fixture?preview=1")).headers[
          "content-disposition"
        ],
      ).toContain("attachment;");
      const generated = await app.inject({
        method: "POST",
        url: "/api/workflows/script-assist",
        payload: { requirement: "test" },
      });
      expect(generated.json()).toEqual({ script: "return {};" });
      expect(assistScript.mock.calls[0]).toHaveLength(2);
      authenticated = false;
      expect(
        (
          await app.inject({
            method: "POST",
            url: "/api/workflows/script-assist",
            payload: {},
          })
        ).statusCode,
      ).toBe(401);
      expect(assistScript).toHaveBeenCalledTimes(1);
      expect(
        (await app.inject("/api/workflow-files/fixture?preview=1")).statusCode,
      ).toBe(401);
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});

/** 真实上传、列表与删除路由共同验证目录隔离、保护冲突与响应缓存边界。 */
it("文件管理 HTTP 支持常量上传预览，拒绝删除引用并标记已删除历史", async () => {
  const root = await mkdtemp(join(tmpdir(), "workflow-files-http-"));
  const files = new WorkflowFiles(join(root, "assets"), {} as never, {} as never);
  const service = new WorkflowService(new WorkflowRepository(root, createTestDatabase()), {execute: async () => ({})}, undefined, (definition, inputs) => files.checkReferences(definition, inputs));
  await service.initialize();
  const app = Fastify();
  await app.register(multipart);
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof DomainError) return reply.code(error.code === "CONFLICT" ? 409 : 400).send(error.toDocument(request.id));
    return reply.code(500).send({message: error instanceof Error ? error.message : String(error)});
  });
  registerWorkflowRoutes(app, {authService: {isAuthenticated: async () => true} as never, service, files, executor: {} as never});
  const upload = async (directory: string) => {
    const response = await app.inject({method: "POST", url: `/api/workflow-files?directory=${directory}`, headers: {"content-type": "multipart/form-data; boundary=workflow-test"}, payload: '--workflow-test\r\nContent-Disposition: form-data; name="file"; filename="readme.txt"\r\nContent-Type: text/plain\r\n\r\nhello workflow\r\n--workflow-test--\r\n'});
    expect(response.statusCode).toBe(200);
    expect(response.headers["cache-control"]).toBe("no-store");
    return response.json();
  };
  try {
    const constant = await upload("constants"), runtime = await upload("runtime");
    const draft = emptyWorkflow();draft.nodes[0].outputs.push({name: "file", type: "file", defaultValue: constant});
    const definition = await service.save(draft);
    const page = await app.inject("/api/workflow-files?directory=constants&q=readme&pageSize=1");
    expect(page.headers["cache-control"]).toBe("no-store");
    expect(page.json()).toMatchObject({total: 1, files: [{assetId: constant.assetId, blockedReason: expect.stringContaining("引用")}]});
    const text = await app.inject(`/api/workflow-files/${constant.assetId}/text`);
    expect(text.json()).toMatchObject({content: "hello workflow", truncated: false});
    expect(text.headers["cache-control"]).toBe("no-store");
    const conflict = await app.inject({method: "DELETE", url: "/api/workflow-files", payload: {ids: [runtime.assetId, constant.assetId]}});
    expect(conflict.statusCode).toBe(409);
    expect(conflict.json().error).toMatchObject({code: "CONFLICT", requestId: expect.any(String)});
    expect((await app.inject(`/api/workflow-files/${runtime.assetId}`)).body).toBe("hello workflow");
    expect((await app.inject({method: "DELETE", url: "/api/workflow-files", payload: {ids: [runtime.assetId]}})).statusCode).toBe(204);
    expect((await app.inject("/api/workflow-files?directory=runtime")).json().total).toBe(0);
    expect((await app.inject(`/api/workflow-files/${runtime.assetId}`)).statusCode).toBe(400);
    await service.remove(definition.id, definition.revision);
    expect((await app.inject({method: "DELETE", url: "/api/workflow-files", payload: {ids: [constant.assetId]}})).statusCode).toBe(204);
    expect((await app.inject("/api/workflow-files?pageSize=101")).statusCode).toBe(400);
  } finally {await app.close();await service.close();await rm(root, {recursive: true, force: true});}
});
