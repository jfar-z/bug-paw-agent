import { createTestDatabase } from "../database/test-database";
import { DEFAULT_AIGC_AGENT_LIMITS } from "./aigc-agent-limits";
import { AigcPublicFileService } from "./aigc-public-file-service";
import { DomainError } from "../core/errors";
import type { MediaAccess } from "../media-library/media-access";
import Fastify from "fastify";
import { registerAigcRoutes } from "../routes/aigc";
import { registerApiV1Namespace } from "../http/api-versioning";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { CredentialService } from "../configuration/credential-service";
import { AigcAssetService } from "./aigc-asset-service";
import { AigcConnectionService } from "./aigc-connection-service";
import { AigcInterfaceService } from "./aigc-interface-service";
import type { AigcExecutionInput, AigcExecutionResult } from "./aigc-protocol-adapter";
import { AigcTaskRepository } from "./aigc-task-repository";
import { AigcTaskService } from "./aigc-task-service";
import { AigcWorkflowService } from "./aigc-workflow-service";

describe("AIGC 任务服务", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function fixture(adapterResult: AigcExecutionResult | Error | ((input: AigcExecutionInput) => Promise<AigcExecutionResult>), protocol: "openai" | "grok" | "comfyui" = "openai", limits = DEFAULT_AIGC_AGENT_LIMITS) {
    const root = await mkdtemp(join(tmpdir(), "aigc-tasks-"));
    roots.push(root);
    const connections = new AigcConnectionService(join(root, "channels.json"));
    await connections.create({
      name: protocol,
      type: protocol,
      baseUrl: "https://api.openai.com/v1",
      enabled: true,
      timeoutMs: 30_000,
    }, protocol, (await connections.read()).revision);
    const workflows = new AigcWorkflowService(join(root, "definitions"), createTestDatabase());
    const interfaces = new AigcInterfaceService(join(root, "interfaces.json"), (id) => workflows.exists(id));
    const workflow = protocol === "comfyui" ? await workflows.create({
      name: "采样", fileName: "sample.json",
      workflowJson: { "1": { class_type: "KSampler", inputs: { steps: 20 } }, "2": { class_type: "SaveImage", inputs: { images: ["1", 0] } } },
      inputMappings: [{ id: "steps", name: "steps", nodeId: "1", field: "inputs.steps", type: "int", required: true, defaultValue: 12 }],
      outputMappings: [{ id: "image", name: "image", nodeId: "2", field: "outputs.images", mediaType: "image" }],
    }) : undefined;
    const created = await interfaces.create({
      name: "文生图",
      description: "",
      protocol,
      capability: "text-to-image",
      channelId: protocol,
      enabled: true,
      toolPublishEnabled: false,
      config: workflow ? { workflowId: workflow.workflow.id } : { model: "dall-e-3" },
    });
    const adapter = {
      execute: vi.fn(async (input: AigcExecutionInput) => {
        if (typeof adapterResult === "function") return adapterResult(input);
        if (adapterResult instanceof Error) throw adapterResult;
        return adapterResult;
      }),
    };
    const assets = new AigcAssetService(join(root, "assets"));
    const publicFiles = new AigcPublicFileService(join(root, "public"));
    const repository = new AigcTaskRepository(join(root, "tasks.json"));
    const service = new AigcTaskService({
      repository,
      interfaces,
      workflows,
      connections,
      credentials: new CredentialService(join(root, "auth.json")),
      assets,
      publicFiles,
      adapters: { [protocol]: adapter },
    }, limits);
    const createApp = (mediaAccess?: MediaAccess) => {
      const app = Fastify();
      registerApiV1Namespace(app);
      registerAigcRoutes(app, { authService: { isAuthenticated: async () => true } as never,
        tasks: service, interfaces, workflows, assets, publicFiles, comfyuiInputs: {} as never, mediaAccess, publicOrigin: "https://media.example" });
      return app;
    };
    return { service, createApp, interfaces, publicFiles, item: created.item, adapter, assets, repository, root };
  }

  it("并发重放只入队一次，磁盘重开及成员删除后仍保留同一回执", async () => {
    const { createApp, root, service, item, adapter } = await fixture({ assets: [] });
    const app = createApp();
    const payload = { interfaceId: item.id, count: 3, inputs: { prompt: "测试" }, requestKey: "manual-1" };
    const submit = (body: typeof payload) => app.inject({ method: "POST", url: "/api/v1/aigc/tasks/batch", payload: body });
    const [first, replay] = await Promise.all([submit(payload), submit(payload)]);
    expect(first.statusCode).toBe(202);
    const { taskIds } = first.json<{ taskIds: string[] }>();
    expect(new Set(taskIds).size).toBe(3);
    expect(replay.json()).toEqual({ taskIds });
    const conflict = await submit({ ...payload, count: 2 });
    expect(conflict.json().error).toMatchObject({ code: "CONFLICT", requestId: expect.any(String) });
    await vi.waitFor(async () => expect((await service.list()).tasks.every(t => t.status === "succeeded")).toBe(true));
    expect(adapter.execute).toHaveBeenCalledTimes(3);
    const draft = await app.inject({ method: "GET", url: "/api/v1/aigc/tasks/" + taskIds[0] + "/rerun-draft" });
    expect(draft.json()).toEqual({ interfaceId: item.id, inputs: payload.inputs, interfaceAvailable: true, issues: [] });
    expect((await service.list()).tasks).toHaveLength(3);
    await service.removeMany(taskIds);
    expect((await submit(payload)).json()).toEqual({ taskIds });
    const { taskFingerprint } = await import("../core/task-preparation");
    const reopened = new AigcTaskRepository(join(root, "tasks.json"));
    expect(await reopened.batchReceipt(payload.requestKey, taskFingerprint([item.id, 3, payload.inputs]))).toEqual({ taskIds });
    await service.close();
    await app.close();
  });

  it("ComfyUI 批次固定映射默认值，取消队中成员或首项失败均保留后续运行", async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let started = 0;
    const f = await fixture(async () => {
      if (++started === 1) {
        await gate;
        throw new Error("测试首个成员执行失败");
      }
      return { assets: [] };
    }, "comfyui", { ...DEFAULT_AIGC_AGENT_LIMITS, maxActiveTasksPerAgent: 1 });
    const app = f.createApp();
    const accepted = await app.inject({ method: "POST", url: "/api/v1/aigc/tasks/batch",
      payload: { interfaceId: f.item.id, count: 3, requestKey: "comfy-batch", inputs: {} } });
    expect(accepted.statusCode).toBe(202);
    const [first, second, third] = accepted.json().taskIds;
    try {
      await vi.waitFor(() => expect(started).toBe(1));
      expect(await f.service.get(second)).toMatchObject({ status: "queued", queueReason: expect.stringContaining("并发额度") });
      expect(await f.service.cancel(second)).toMatchObject({ status: "cancelled", upstreamCancellation: "confirmed" });
      release();
      await vi.waitFor(async () => expect(await f.service.get(third)).toMatchObject({ status: "succeeded", inputs: { steps: 12 } }));
      expect(await f.service.get(first)).toMatchObject({ status: "failed", startedAt: expect.any(String) });
      expect(started).toBe(2);
    } finally {
      release();
      await f.service.close();
      await app.close();
    }
  });

  it("整批共用一次公网确认和一组有序副本，再次运行重新检查媒体库来源", async () => {
    const f = await fixture({ assets: [] }, "grok");
    const { item } = await f.interfaces.create({ ...f.item, capability: "image-edit" });
    const first = "media-library://images/first", second = "media-library://images/second";
    const read = vi.fn(async (ref: string) => ({ name: ref.endsWith("first") ? "甲.png" : "乙.png", mediaType: "image/png", content: Buffer.from("png") }));
    const describe = vi.fn(async (_ref: string) => {});
    const app = f.createApp({ read, describe } as unknown as MediaAccess);
    const inputs = { prompt: "编辑", image: [second, first] };
    const payload = { interfaceId: item.id, requestKey: "media-confirm", count: 3, inputs };
    const submit = (confirmed: boolean) => app.inject({ method: "POST", url: "/api/v1/aigc/tasks/batch",
      payload: { ...payload, confirmPublicTransfer: confirmed } });
    expect((await submit(false)).json().error.details).toMatchObject({ field: "image", requiresPublicTransfer: true });
    expect((await f.service.list()).tasks).toHaveLength(0);
    expect(await f.publicFiles.list()).toHaveLength(0);
    const accepted = await submit(true);
    expect(accepted.statusCode).toBe(202);
    const { taskIds } = accepted.json<{ taskIds: string[] }>();
    expect(taskIds).toHaveLength(3);
    expect(read.mock.calls.map(call => call[0])).toEqual([second, first]);
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(3));
    const executions = f.adapter.execute.mock.calls.map(([request]) => request.inputs);
    expect(executions[0].image).toMatchObject([{ name: "乙.png" }, { name: "甲.png" }]);
    expect(executions).toEqual(Array(3).fill(executions[0]));
    describe.mockImplementation(async ref => {
      if (ref === second) throw new DomainError("NOT_FOUND", "媒体已删除");
    });
    const draft = await app.inject({ method: "GET", url: "/api/v1/aigc/tasks/" + taskIds[1] + "/rerun-draft" });
    expect(draft.json()).toMatchObject({ inputs: { prompt: "编辑", image: [first] }, issues: [{ field: "image", message: "媒体已删除" }] });
    expect((await submit(true)).json()).toEqual({ taskIds });
    expect(read).toHaveBeenCalledTimes(2);
    await f.service.close();
    await app.close();
  });

  it("历史任务只回填当前业务字段与显式零值，私有媒体和诊断均不能填入草稿", async () => {
    const f = await fixture({ assets: [] });
    const { item, revision } = await f.interfaces.create({ ...f.item, capability: "image-edit", config: {
      model: "image", parameters: [{ name: "scale", type: "integer", description: "比例" }, { name: "flag", type: "boolean", description: "开关" }],
    } });
    const now = new Date().toISOString();
    const task = await f.repository.create({ id: "historical", status: "failed", interfaceId: item.id, interfaceName: item.name,
      channelId: item.channelId, createdAt: now, updatedAt: now, assets: [], mcpOrigin: { clientId: "demo", requestHash: "hash", requestKey: "m" },
      inputs: { prompt: "历史输入", image: { assetId: "private", name: "私有文件", mediaType: "image/png" }, scale: 0, flag: false, oldField: "旧值" },
      diagnostics: { response: { body: "诊断正文", truncated: false, endpoint: "generation", status: 400 } } });
    const app = f.createApp();
    const getDraft = () => app.inject({ method: "GET", url: "/api/v1/aigc/tasks/" + task.id + "/rerun-draft" });
    const draft = (await getDraft()).json();
    expect(draft.inputs).toEqual({ prompt: "历史输入", scale: 0, flag: false });
    expect(draft.issues.map((issue: { field: string }) => issue.field).sort()).toEqual(["image", "oldField"]);
    expect(JSON.stringify(draft)).not.toMatch(/私有文件|诊断正文|旧值/);
    await f.interfaces.update(item.id, { ...item, enabled: false }, revision);
    expect((await getDraft()).json()).toMatchObject({ interfaceId: item.id, interfaceAvailable: false, inputs: {} });
    expect((await f.service.list()).tasks).toHaveLength(1);
    expect(f.adapter.execute).not.toHaveBeenCalled();
    await f.service.close();
    await app.close();
  });

  it("批次校验或写盘失败时没有成员可见或执行，修复后可原键提交", async () => {
    const { createApp, root, service, item, adapter } = await fixture({ assets: [] });
    const app = createApp();
    const payload = { interfaceId: item.id, count: 3, inputs: { prompt: "测试" }, requestKey: "manual-failure" };
    const submit = (body: Record<string, unknown>) => app.inject({ method: "POST", url: "/api/v1/aigc/tasks/batch", payload: body });
    for (const count of ["", 0, 2.5, "3", 11]) {
      const invalid = await submit({ ...payload, count });
      expect(invalid.statusCode).toBe(400);
      expect(invalid.json().error).toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("1～10"), requestId: expect.any(String) });
    }
    expect((await submit({ ...payload, inputs: {} })).json().error.details.field).toBe("prompt");
    const history = join(root, "tasks.json");
    await mkdir(history);
    expect((await submit(payload)).statusCode).toBeGreaterThanOrEqual(400);
    expect((await service.list()).tasks).toEqual([]);
    expect(adapter.execute).not.toHaveBeenCalled();
    await rm(history, { recursive: true });
    expect((await submit(payload)).json().taskIds).toHaveLength(3);
    await vi.waitFor(() => expect(adapter.execute).toHaveBeenCalledTimes(3));
    await service.close();
    await app.close();
  });

  it("诊断持久化重开可读、列表不携带正文且重试清除旧快照", async () => {
    const diagnostics = { request: { method: "POST" as const, endpoint: "images/generations", body: { prompt: "猫" } }, response: { endpoint: "images/generations", status: 400, body: "bad_size", truncated: false } };
    const { service, item, root } = await fixture(async (input) => {
      await input.onDiagnostics?.({ request: diagnostics.request });
      await input.onDiagnostics?.({ response: diagnostics.response });
      throw new Error("上游服务返回 400");
    });
    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "猫" } });
    await vi.waitFor(async () => expect((await service.get(task.id))?.status).toBe("failed"));
    expect((await service.get(task.id))?.diagnostics).toEqual(diagnostics);
    expect(JSON.stringify(await service.list())).not.toContain("diagnostics");
    expect((await new AigcTaskRepository(join(root, "tasks.json")).get(task.id))?.diagnostics).toEqual(diagnostics);
    expect((await service.retry(task.id))?.diagnostics).toBeUndefined();
    await service.close();
  });

  it("创建任务后异步执行并保存产物", async () => {
    const { service, item } = await fixture({
      assets: [{ name: "image.png", mediaType: "image/png", content: Buffer.from("png") }],
    });

    const task = await service.createRun({ interfaceId: item.id, inputs: { prompt: "一只猫" } });

    expect(task.status).toBe("queued");
    await vi.waitFor(async () => {
      expect((await service.get(task.id))?.status).toBe("succeeded");
    });
    const done = await service.get(task.id);
    expect(done?.assets).toEqual([expect.objectContaining({ name: "image.png", mediaType: "image/png" })]);
  });

  it.each(["openai", "grok"] as const)("%s 接口拒绝 ComfyUI input 来源", async (protocol) => {
    const { service, item, adapter } = await fixture({ assets: [] }, protocol);

    await expect(service.createRun({
      interfaceId: item.id,
      inputs: {
        prompt: "测试",
        image: { filename: "source.png", name: "source.png", mediaType: "image/png", source: "comfyui_input" },
      },
    })).rejects.toThrow("仅 ComfyUI 接口支持 ComfyUI input");
    expect(adapter.execute).not.toHaveBeenCalled();
  });

  it("按任务和产物创建时间稳定排序产物", async () => {
    const { service, repository, item } = await fixture({ assets: [] });
    const base = {
      interfaceId: item.id,
      interfaceName: item.name,
      channelId: item.channelId,
      status: "succeeded" as const,
      inputs: {},
      updatedAt: "2026-09-09T10:00:00.000Z",
    };
    await repository.create({
      ...base,
      id: "task-z",
      createdAt: "2026-09-08T10:00:00.000Z",
      assets: [{ id: "asset-z", name: "older.png", mediaType: "image/png", size: 1, createdAt: "2026-09-08T10:00:01.000Z" }],
    });
    await repository.create({
      ...base,
      id: "task-a",
      createdAt: "2026-09-09T10:00:00.000Z",
      assets: [{ id: "asset-a", name: "newer.png", mediaType: "image/png", size: 1, createdAt: "2026-09-09T10:00:01.000Z" }],
    });

    const descending = await service.listOutputs({ kind: "image", sort: "desc", page: 1, pageSize: 24 });
    const ascending = await service.listOutputs({ kind: "image", sort: "asc", page: 1, pageSize: 24 });

    expect(descending.items.map((asset) => asset.name)).toEqual(["newer.png", "older.png"]);
    expect(ascending.items.map((asset) => asset.name)).toEqual(["older.png", "newer.png"]);
  });

  it("批量删除任务并清理对应产物", async () => {
    const { service, repository, item, assets } = await fixture({ assets: [] });
    const removeTaskOutputs = vi.spyOn(assets, "removeTaskOutputs");
    const base = {
      interfaceId: item.id,
      interfaceName: item.name,
      channelId: item.channelId,
      status: "succeeded" as const,
      inputs: {},
      assets: [],
      createdAt: "2026-09-17T10:00:00.000Z",
      updatedAt: "2026-09-17T10:00:00.000Z",
    };
    await repository.create({ ...base, id: "task-batch-1" });
    await repository.create({ ...base, id: "task-batch-2" });

    await expect(service.removeMany(["task-batch-1", "task-batch-2"])).resolves.toEqual({
      removedIds: ["task-batch-1", "task-batch-2"],
    });
    await expect(repository.list()).resolves.toEqual([]);
    expect(removeTaskOutputs).toHaveBeenCalledTimes(2);
  });

});
