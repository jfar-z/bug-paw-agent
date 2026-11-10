import { createTestDatabase } from "../database/test-database";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentStore } from "../agents/agent-store";
import { createWorkspaceFileService } from "../attachments";
import { createWorkspaceFileManager } from "../workspace-files";
import { CredentialService } from "../configuration/credential-service";
import { DEFAULT_AGENT_TOOL_NAMES } from "../../shared/tool-catalog";
import { AigcAssetService } from "./aigc-asset-service";
import { AigcConnectionService } from "./aigc-connection-service";
import { AigcInterfaceService } from "./aigc-interface-service";
import { AigcPublicFileService } from "./aigc-public-file-service";
import { AigcWorkflowService } from "./aigc-workflow-service";
import { AigcTaskRepository } from "./aigc-task-repository";
import { AigcTaskService } from "./aigc-task-service";
import { AigcAgentService } from "./aigc-agent-service";
import type { AigcAgentLimits } from "./aigc-agent-limits";
import { createAigcAgentTools } from "./aigc-agent-tools";
import { agentFields, validateAgentParameters } from "./aigc-agent-parameters";
import type { AigcExecutionInput, AigcExecutionResult } from "./aigc-protocol-adapter";
import type { AigcWorkflowDetail } from "../../shared/aigc-contracts";

const context = { agentId: "agent-a", sessionId: "session-a" };
const toolNames = ["aigc_list_interfaces", "aigc_create_task", "aigc_run", "aigc_get_task", "aigc_cancel_task", "aigc_run_and_wait"];
const pending = (input: AigcExecutionInput): Promise<AigcExecutionResult> => new Promise((_resolve, reject) => {
  input.signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
});

/** 使用真实任务存储、文件边界和发布配置，仅替换上游生成服务。 */
async function fixture(
  execute: (input: AigcExecutionInput) => Promise<AigcExecutionResult> = async () => ({
    assets: [{ name: "result.png", mediaType: "image/png", content: Buffer.from("result") }],
  }),
  limits?: AigcAgentLimits,
  publicOrigin: string | null = "https://bugpaw.example",
) {
  const root = await mkdtemp(join(tmpdir(), "aigc-agent-"));
  const workspaces = join(root, "workspaces");
  await mkdir(join(workspaces, "agent-a"), { recursive: true });
  await mkdir(join(workspaces, "agent-b"), { recursive: true });
  const agents = { resolveWorkspace: async (id: string) => join(workspaces, id) } as AgentStore;
  const workspace = createWorkspaceFileManager(agents);
  const files = createWorkspaceFileService({} as never, agents);
  const connections = new AigcConnectionService(join(root, "connections.json"));
  await connections.create({ name: "Test", type: "openai", baseUrl: "https://private.invalid/v1", enabled: true }, "channel", (await connections.read()).revision);
  await connections.create({ name: "Grok", type: "grok", baseUrl: "https://grok.invalid/v1", enabled: true }, "grok-channel", (await connections.read()).revision);
  await connections.create({ name: "ComfyUI", type: "comfyui", baseUrl: "https://comfy.invalid", enabled: true }, "comfy-channel", (await connections.read()).revision);
  const workflows = new AigcWorkflowService(join(root, "definitions"), createTestDatabase());
  const interfaces = new AigcInterfaceService(join(root, "interfaces.json"), (id) => workflows.exists(id));
  const { item } = await interfaces.create({
    name: "测试接口", description: "生成测试", protocol: "openai", capability: "text-to-image",
    toolDescription: "Generate an Agent test image with up to 10 steps.",
    channelId: "channel", enabled: true, toolPublishEnabled: true,
    config: { model: "test", parameters: [{ name: "steps", type: "integer", defaultValue: 8, description: "步数" }] },
  });
  const assets = new AigcAssetService(join(root, "assets"));
  const publicFiles = new AigcPublicFileService(join(root, "public-files"));
  const repository = new AigcTaskRepository(join(root, "tasks.json"));
  const adapter = { execute: vi.fn(execute) };
  const tasks = new AigcTaskService({
    repository, interfaces, workflows, connections, assets, publicFiles,
    credentials: new CredentialService(join(root, "auth.json")), adapters: { openai: adapter, grok: adapter, comfyui: adapter },
  }, limits);
  let allowed = [...toolNames];
  const dependencies = {
    interfaces, workflows, connections, assets, publicFiles, publicOrigin: publicOrigin ?? undefined,
    tasks, workspace, files, allowedTools: async () => allowed,
  };
  const service = limits ? new AigcAgentService(dependencies, limits) : new AigcAgentService(dependencies);
  const tools = createAigcAgentTools(context, service);
  const submit = (requestKey = "one") => ({ interfaceId: item.id, requestKey, parameters: [{ name: "prompt", value: "test" }] });
  const close = async () => {
    await tasks.close();
    await rm(root, { recursive: true, force: true });
  };
  cleanup.push(close);
  // 旧回归场景显式经过新建和运行两步，生产工具不保留旧协议。
  const run = async (ctx: typeof context, input: Parameters<AigcAgentService["create"]>[1], signal?: AbortSignal) => {
    const created = await service.create(ctx, input, signal);
    return (await service.run(ctx, { taskIds: [created.taskId] }, signal)).tasks[0];
  };
  const wait = async (ctx: typeof context, input: Parameters<AigcAgentService["create"]>[1], signal?: AbortSignal,
    progress?: (state: Awaited<ReturnType<AigcAgentService["get"]>>) => void) => {
    const created = await service.create(ctx, input, signal);
    const state = await service.runAndWait(ctx, { taskIds: [created.taskId] }, signal, (batch) => progress?.(batch.tasks[0]));
    return { ...state.tasks[0], waitStatus: state.waitStatus };
  };
  return { root, workspaces, service, tools, tasks, repository, run, wait, interfaces, connections, workflows, assets, publicFiles, adapter, item, submit,
    revoke: () => { allowed = []; },
    setAllowed: (names: string[]) => { allowed = names; },
    unpublish: async () => interfaces.update(item.id, { ...item, toolPublishEnabled: false }, (await interfaces.list()).revision),
  };
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0)) await close();
});

describe("AIGC Agent 工具", () => {
  it("创建只校验并持久化，默认值回显且不占执行额度，重启保留待运行状态", async () => {
    const f = await fixture(pending, { maxActiveTasks: 1, maxActiveTasksPerAgent: 1, maxHourlyTasksPerAgent: 1, queryIntervalMs: 1000 });
    const save = vi.spyOn(f.assets, "saveInput"), publish = vi.spyOn(f.publicFiles, "save");
    const a = await f.service.create(context, f.submit("a"));
    const b = await f.service.create(context, f.submit("b"));
    expect(a).toMatchObject({ status: "prepared", parameters: { prompt: "test", steps: 8 } });
    expect(b.status).toBe("prepared");
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    expect(await new AigcTaskRepository(join(f.root, "tasks.json")).get(a.taskId)).toMatchObject({ status: "prepared" });
    await f.service.run(context, { taskIds: [a.taskId, b.taskId] });
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
    expect(await f.tasks.get(b.taskId)).toMatchObject({ status: "queued", queueReason: expect.stringContaining("并发额度") });
    await f.service.cancel(context, a.taskId);
    expect(await f.tasks.get(b.taskId)).toMatchObject({ status: "queued", queueReason: expect.stringContaining("小时额度") });
    await f.service.cancel(context, b.taskId);
    expect((await f.tasks.get(b.taskId))?.upstreamCancellation).toBe("confirmed");
  });

  it("批量先启动全部任务再等待，失败任务不阻断其他成功产物，重复运行不重新生成", async () => {
    const entered: string[] = [];
    const f = await fixture(async (input) => {
      entered.push(input.inputs.prompt as string);
      await vi.waitFor(() => expect(entered).toHaveLength(2));
      if (input.inputs.prompt === "bad") throw new Error("上游测试拒绝生成");
      return { assets: [{ name: "ok.png", mediaType: "image/png", content: Buffer.from("ok") }] };
    });
    const a = await f.service.create(context, f.submit("a"));
    const b = await f.service.create(context, { ...f.submit("b"), parameters: [{ name: "prompt", value: "bad" }] });
    const result = await f.service.runAndWait(context, { taskIds: [a.taskId, b.taskId] });
    expect(result.waitStatus).toBe("completed");
    expect(result.tasks.map((task) => task.taskId)).toEqual([a.taskId, b.taskId]);
    expect(result.tasks.map((task) => task.status)).toEqual(["succeeded", "failed"]);
    expect(result.tasks[0].files).toHaveLength(1);
    expect(result.tasks[1].error?.message).toContain("上游测试拒绝生成");
    await f.service.run(context, { taskIds: [a.taskId, b.taskId] });
    expect(f.adapter.execute).toHaveBeenCalledTimes(2);
    const tool = f.tools.find((entry) => entry.name === "aigc_run_and_wait")!;
    await expect(tool.execute("partial", { taskIds: [a.taskId, b.taskId] } as never, undefined, undefined, {} as never))
      .rejects.toThrow(/AIGC_TASK_FAILED.*attachments/);
  }, 15000);

  it("整批包含无权访问的 ID 或重复 ID 时不启动任何任务", async () => {
    const f = await fixture(pending);
    const a = await f.service.create(context, f.submit("a"));
    for (const taskIds of [[a.taskId, "missing"], [a.taskId, a.taskId], [], [a.taskId, "b", "c"]])
      await expect(f.service.run(context, { taskIds })).rejects.toThrow();
    await expect(f.service.run({ ...context, agentId: "agent-b" }, { taskIds: [a.taskId] })).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect((await f.tasks.get(a.taskId))?.status).toBe("prepared");
  });

  it("文件或定义变化拒绝整批，待运行取消不访问上游", async () => {
    const f = await fixture(pending);
    await f.interfaces.update(f.item.id, { ...f.item, capability: "image-edit" }, (await f.interfaces.list()).revision);
    await writeFile(join(f.workspaces, "agent-a", "source.png"), "original");
    const a = await f.service.create(context, f.submit("a"));
    const b = await f.service.create(context, { ...f.submit("b"), parameters: [{ name: "prompt", value: "x" }, { name: "image", value: "source.png" }] });
    expect(await f.publicFiles.list()).toHaveLength(0);
    await writeFile(join(f.workspaces, "agent-a", "source.png"), "changed");
    await expect(f.service.run(context, { taskIds: [a.taskId, b.taskId] })).rejects.toMatchObject({ code: "AIGC_INPUT_CHANGED" });
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect((await f.tasks.get(a.taskId))?.status).toBe("prepared");
    await f.interfaces.update(f.item.id, { ...f.item, name: "changed" }, (await f.interfaces.list()).revision);
    await expect(f.service.run(context, { taskIds: [a.taskId] })).rejects.toMatchObject({ code: "AIGC_INTERFACE_CHANGED" });
    expect(await f.service.cancel(context, a.taskId)).toMatchObject({ status: "cancelled", upstreamCancellation: "confirmed" });
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it("批量持久化失败时整批保持待运行且不调用上游", async () => {
    const f = await fixture(pending);
    const a = await f.service.create(context, f.submit("a"));
    const b = await f.service.create(context, f.submit("b"));
    vi.spyOn(f.repository, "submitPrepared").mockRejectedValueOnce(new Error("模拟持久化中断"));
    await expect(f.service.run(context, { taskIds: [a.taskId, b.taskId] })).rejects.toThrow("持久化中断");
    expect(f.adapter.execute).not.toHaveBeenCalled();
    expect((await f.tasks.listRecords()).map((task) => task.status)).toEqual(["prepared", "prepared"]);
  });

  it("阻塞工具仅需自身授权，等待真实完成并通过回调报告进度与交付产物", async () => {
    const f = await fixture(async (input) => {
      input.onProgress?.({ phase: "running", progressValue: 1, progressMax: 2, updatedAt: new Date().toISOString() });
      return { assets: [{ name: "result.png", mediaType: "image/png", content: Buffer.from("result") }] };
    });
    const created = await f.service.create(context, f.submit());
    f.setAllowed(["aigc_run_and_wait"]);
    const updates = vi.fn();
    const tool = f.tools.find((entry) => entry.name === "aigc_run_and_wait")!;
    const output = await tool.execute("wait-call", { taskIds: [created.taskId] }, undefined, updates, {} as never);
    const block = output.content[0];
    if (block.type !== "text") throw new Error("工具必须返回文本结果");
    const payload = JSON.parse(block.text);
    expect(payload.data).toMatchObject({ tasks: [{ status: "succeeded" }], waitStatus: "completed" });
    expect(payload.data.tasks[0].files).toHaveLength(1);
    expect(updates).toHaveBeenCalled();
    expect(JSON.parse(updates.mock.calls[0][0].content[0].text).data.tasks[0].taskId).toBe(payload.data.tasks[0].taskId);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    await expect(f.run(context, f.submit("denied"))).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.get(context, payload.data.tasks[0].taskId)).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
  }, 15_000);

  it("中止阻塞等待保留后台任务，未取消上游且同键再次等待不重复提交", async () => {
    const f = await fixture(pending);
    const controller = new AbortController();
    const state = await f.wait(context, f.submit(), controller.signal, () => controller.abort());
    expect(state.waitStatus).toBe("interrupted");
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    expect(f.adapter.execute.mock.calls[0][0].signal.aborted).toBe(false);
    const again = new AbortController();
    const resumed = await f.wait(context, f.submit(), again.signal, () => again.abort());
    expect(resumed.taskId).toBe(state.taskId);
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    expect((await f.tasks.get(state.taskId))?.status).toBe("running");
  });

  it("等待上限到达返回当前任务而不取消或重提", async () => {
    const f = await fixture(pending);
    const now = Date.now();
    const state = await f.wait(context, f.submit(), undefined, () => {
      vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    });
    expect(state).toMatchObject({ waitStatus: "timed_out" });
    expect(["queued", "running"]).toContain(state.status);
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    expect(f.adapter.execute.mock.calls[0][0].signal.aborted).toBe(false);
  });

  it("两种工具共享幂等，已失败或取消的任务直接返回终态", async () => {
    const f = await fixture(async () => { throw new Error("upstream failure"); });
    const submitted = await f.run(context, f.submit());
    await vi.waitFor(async () => expect((await f.tasks.get(submitted.taskId))?.status).toBe("failed"));
    const state = await f.wait(context, f.submit());
    expect(state).toMatchObject({ taskId: submitted.taskId, status: "failed", waitStatus: "completed", files: [] });
    expect(f.adapter.execute).toHaveBeenCalledOnce();
    await f.repository.update(submitted.taskId, { status: "cancelled" });
    expect(await f.wait(context, f.submit())).toMatchObject({ status: "cancelled", waitStatus: "completed" });
  });

  it("等待期间撤销授权或发布会阻止继续读取，参数错误不产生任务", async () => {
    const f = await fixture(pending);
    await expect(f.wait(context, { ...f.submit(), parameters: [] })).rejects.toBeInstanceOf(TypeError);
    expect(await f.tasks.listRecords()).toHaveLength(0);
    await expect(f.wait(context, f.submit(), undefined, () => f.revoke())).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    f.setAllowed(toolNames);
    await f.unpublish();
    await expect(f.wait(context, f.submit())).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
  });

  it("工具根 Schema 为对象且默认不授权，列表不泄露渠道地址", async () => {
    const f = await fixture();
    expect(f.tools.map((tool) => tool.name)).toEqual(toolNames);
    for (const name of ["aigc_run", "aigc_run_and_wait"]) {
      const schema = f.tools.find((tool) => tool.name === name)!.parameters;
      expect(schema.required).toEqual(["taskIds"]);
      expect(Object.keys(schema.properties!)).toEqual(["taskIds"]);
    }
    for (const tool of f.tools) {
      expect(tool.parameters.type).toBe("object");
      for (const key of ["anyOf", "oneOf", "allOf"]) expect(tool.parameters).not.toHaveProperty(key);
      expect(DEFAULT_AGENT_TOOL_NAMES).not.toContain(tool.name);
    }
    const discoveryTool = f.tools.find((tool) => tool.name === "aigc_list_interfaces")!;
    expect(discoveryTool.parameters.required).toEqual(["action", "interfaceId", "offset"]);
    expect(JSON.stringify(discoveryTool.parameters)).not.toContain('"optional"');
    const runParameters = f.tools.find((tool) => tool.name === "aigc_create_task")?.parameters;
    expect(JSON.stringify(runParameters)).not.toContain('"url"');
    const parameterSchema = (runParameters as {
      properties: { parameters: { items: { required: string[]; properties: Record<string, unknown> } } };
    }).properties.parameters.items;
    expect(parameterSchema.required).toEqual(["name", "value"]);
    expect(Object.keys(parameterSchema.properties)).toEqual(["name", "value"]);
    expect(JSON.stringify(parameterSchema.properties.value)).toContain('"type":"null"');
    const listOutput = await discoveryTool.execute("list-call", {
      action: "list", interfaceId: null, offset: 0,
    }, undefined, undefined, {} as never);
    const listBlock = listOutput.content[0];
    if (listBlock.type !== "text") throw new Error("工具必须返回文本结果");
    const list = JSON.parse(listBlock.text).data;
    expect(JSON.stringify(list)).not.toContain("private.invalid");
    expect(list.interfaces).toHaveLength(1);
    const detailOutput = await discoveryTool.execute("detail-call", {
      action: "get", interfaceId: f.item.id, offset: null,
    }, undefined, undefined, {} as never);
    const detailBlock = detailOutput.content[0];
    if (detailBlock.type !== "text") throw new Error("工具必须返回文本结果");
    const detail = JSON.parse(detailBlock.text).data;
    expect(detail.interfaces[0]).toMatchObject({
      description: "Generate an Agent test image with up to 10 steps.",
      instructions: "Generate an Agent test image with up to 10 steps.",
      outputs: [{ id: "result", name: "result", mediaType: "image", multiple: true }],
    });
    expect(detail.interfaces[0]).toHaveProperty("fields", expect.arrayContaining([expect.objectContaining({ name: "steps", defaultValue: 8 })]));
    await f.unpublish();
    expect((await f.service.list(context, {})).interfaces).toHaveLength(0);
    await expect(f.service.list(context, { interfaceId: f.item.id })).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
  });

  it("接口发现工具拒绝空对象、伪造列表 ID 和缺失详情 ID", async () => {
    const f = await fixture();
    const tool = f.tools.find((entry) => entry.name === "aigc_list_interfaces")!;
    const list = vi.spyOn(f.service, "list");
    for (const params of [
      {},
      { action: "list", interfaceId: "guessed", offset: 0 },
      { action: "list", interfaceId: null, offset: null },
      { action: "get", interfaceId: null, offset: null },
      { action: "get", interfaceId: f.item.id, offset: 0 },
    ]) {
      await expect(tool.execute("invalid-call", params as never, undefined, undefined, {} as never)).rejects.toThrow("AIGC_INPUT_INVALID");
    }
    expect(list).not.toHaveBeenCalled();
  });

  it("returns ComfyUI output definitions in interface details", async () => {
    const f = await fixture();
    const created = await f.workflows.create({
      name: "Output workflow",
      fileName: "outputs.json",
      workflowJson: {
        "1": { class_type: "SaveImage", inputs: {} },
        "2": { class_type: "SaveImage", inputs: {} },
      },
      inputMappings: [],
      outputMappings: [
        { id: "preview", name: "preview", nodeId: "1", field: "outputs.images", mediaType: "image", description: "Low-resolution preview" },
        { id: "final", name: "final", nodeId: "2", field: "outputs.images", mediaType: "image", description: "Final image" },
      ],
    });
    await f.interfaces.update(f.item.id, {
      ...f.item,
      protocol: "comfyui",
      capability: "text-to-image",
      channelId: "comfy-channel",
      config: { workflowId: created.workflow.id },
    }, (await f.interfaces.list()).revision);

    const detail = await f.service.list(context, { interfaceId: f.item.id });
    expect(detail.interfaces[0]).toHaveProperty("outputs", [
      { id: "preview", name: "preview", mediaType: "image", description: "Low-resolution preview", multiple: true },
      { id: "final", name: "final", mediaType: "image", description: "Final image", multiple: true },
    ]);
  });

  it("并发重试只生成一次，记录身份且跨重启保持幂等凭据", async () => {
    const f = await fixture();
    const [a, b] = await Promise.all([f.run(context, f.submit()), f.run(context, f.submit())]);
    expect(a.taskId).toBe(b.taskId);
    await vi.waitFor(async () => expect((await f.tasks.get(a.taskId))?.status).toBe("succeeded"));
    expect(f.adapter.execute).toHaveBeenCalledTimes(1);
    const stored = await new AigcTaskRepository(join(f.root, "tasks.json")).get(a.taskId);
    expect(stored?.agentOrigin).toMatchObject({ ...context, requestKey: "one" });
    expect(f.adapter.execute.mock.calls[0][0].inputs.steps).toBe(8);
    await expect(f.run(context, { ...f.submit(), parameters: [{ name: "prompt", value: "changed" }] })).rejects.toMatchObject({ code: "AIGC_IDEMPOTENCY_CONFLICT" });
  });

  it("归属校验拒绝其他 Agent 和历史手动任务", async () => {
    const f = await fixture();
    const own = await f.run(context, f.submit());
    const manual = await f.tasks.createRun({ interfaceId: f.item.id, inputs: { prompt: "manual" } });
    for (const taskId of [own.taskId, manual.id, "missing"]) {
      await expect(f.service.get({ agentId: "agent-b", sessionId: "other" }, taskId)).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
      await expect(f.service.cancel({ agentId: "agent-b", sessionId: "other" }, taskId)).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
    }
    await expect(f.service.get(context, manual.id)).rejects.toMatchObject({ code: "AIGC_TASK_NOT_FOUND" });
  });

  it("撤销授权和发布立即生效，但撤销发布后仍可取消自己的任务", async () => {
    const f = await fixture(pending);
    const task = await f.run(context, f.submit());
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    await f.unpublish();
    await expect(f.run(context, f.submit("two"))).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
    await expect(f.service.get(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_INTERFACE_UNAVAILABLE" });
    expect(await f.service.cancel(context, task.taskId)).toMatchObject({ status: "cancelled", upstreamCancellation: "unknown" });
    f.revoke();
    await expect(f.service.list(context, {})).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.get(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.service.cancel(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
    await expect(f.run(context, f.submit("three"))).rejects.toMatchObject({ code: "AIGC_TOOL_DENIED" });
  });

  it("校验参数失败时不创建任务或调用上游", async () => {
    const f = await fixture();
    const gptFilledLegacyParameters = [{
      name: "prompt", text: "x", number: 0, boolean: false, path: null,
    }];
    await expect(f.run(context, {
      ...f.submit(), parameters: gptFilledLegacyParameters as never,
    })).rejects.toThrow("每个参数必须且只能提供 name 和 value");
    for (const parameters of [
      [], [{ name: "prompt", value: "" }], [{ name: "prompt", value: "x", text: "x" }],
      [{ name: "prompt", value: "x" }, { name: "prompt", value: "y" }],
      [{ name: "prompt", value: "x" }, { name: "steps", value: 1.5 }],
      [{ name: "prompt", value: null }],
      [{ name: "agentId", value: "agent-b" }],
    ]) await expect(f.run(context, { ...f.submit(), parameters })).rejects.toBeInstanceOf(TypeError);
    expect(await f.tasks.listRecords()).toHaveLength(0);
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });

  it("限制每个 Agent 两个并发任务，并拒绝过频查询", async () => {
    const f = await fixture(pending, {
      maxActiveTasks: 8,
      maxActiveTasksPerAgent: 2,
      maxHourlyTasksPerAgent: 20,
      queryIntervalMs: 2_000,
    });
    const task = await f.run(context, f.submit());
    await f.run(context, f.submit("two"));
    const third = await f.run(context, f.submit("three"));
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(2));
    expect(await f.tasks.get(third.taskId)).toMatchObject({ status: "queued" });
    await f.service.cancel(context, task.taskId);
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(3));
    await f.service.get(context, task.taskId);
    await expect(f.service.get(context, task.taskId)).rejects.toMatchObject({ code: "AIGC_QUERY_TOO_FREQUENT" });
  });

  it("生成产物同时保留于工作台并仅交付一次到所属工作区", async () => {
    const f = await fixture();
    const task = await f.run(context, f.submit());
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    const first = await f.service.get(context, task.taskId);
    expect(first.files).toHaveLength(1);
    expect(first.files[0].path).toMatch(/^attachments\//);
    expect(first.files[0]).toMatchObject({ outputId: "result", outputName: "result" });
    expect(await readFile(join(f.workspaces, context.agentId, first.files[0].path), "utf8")).toBe("result");
    expect((await f.tasks.get(task.taskId))?.assets).toHaveLength(1);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_000);
    const second = await f.service.get(context, task.taskId);
    expect(second.files).toEqual(first.files);
    expect(JSON.stringify(second)).not.toContain(f.root);
  });

  it("preserves output mapping identities for multiple delivered files", async () => {
    const f = await fixture(async () => ({
      assets: [
        { name: "preview.png", mediaType: "image/png", content: Buffer.from("preview"), outputId: "preview", outputName: "" },
        { name: "final.png", mediaType: "image/png", content: Buffer.from("final"), outputId: "final", outputName: "" },
      ],
    }));
    const task = await f.run(context, f.submit());
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    const result = await f.service.get(context, task.taskId);
    expect(result.files).toEqual([
      expect.objectContaining({ name: "preview.png", outputId: "preview", outputName: "" }),
      expect.objectContaining({ name: "final.png", outputId: "final", outputName: "" }),
    ]);
  });

  it("工作区媒体拒绝越界、符号链接和错误类型，正确文件进入私有入参区", async () => {
    const f = await fixture();
    await f.interfaces.update(f.item.id, { ...f.item, capability: "image-edit" }, (await f.interfaces.list()).revision);
    await writeFile(join(f.workspaces, "agent-a", "source.png"), "png");
    await writeFile(join(f.workspaces, "agent-a", "source.txt"), "text");
    await symlink(join(f.workspaces, "agent-a", "source.png"), join(f.workspaces, "agent-a", "link.png"));
    for (const path of ["../agent-b/secret.png", "/etc/passwd", "link.png", "source.txt", "missing.png"]) {
      await expect(f.run(context, { ...f.submit(), parameters: [{ name: "prompt", value: "x" }, { name: "image", value: path }] })).rejects.toThrow();
    }
    expect(await f.tasks.listRecords()).toHaveLength(0);
    const task = await f.run(context, { ...f.submit(), parameters: [{ name: "prompt", value: "x" }, { name: "image", value: "source.png" }] });
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    const asset = f.adapter.execute.mock.calls[0][0].inputs.image as { assetId: string };
    expect(asset.assetId).toBeTruthy();
    expect(await f.assets.resolveInputPath(asset.assetId)).toBeTruthy();
    expect(await f.publicFiles.list()).toHaveLength(0);
  });

  it("OpenAI 图片生成与编辑允许省略参考图或显式传 null", async () => {
    const f = await fixture();
    await f.interfaces.update(f.item.id, { ...f.item, capability: "image-edit" }, (await f.interfaces.list()).revision);
    const detail = await f.service.list(context, { interfaceId: f.item.id });
    expect(detail.interfaces[0]).toHaveProperty("fields", expect.arrayContaining([
      expect.objectContaining({ name: "image", required: false, source: "workspace" }),
    ]));
    const saveInput = vi.spyOn(f.assets, "saveInput");

    const withoutImage = await f.run(context, {
      ...f.submit("without-image"),
      parameters: [{ name: "prompt", value: "x" }],
    });
    const nullImage = await f.run(context, {
      ...f.submit("null-image"),
      parameters: [{ name: "prompt", value: "x" }, { name: "image", value: null }],
    });
    await vi.waitFor(async () => {
      expect((await f.tasks.get(withoutImage.taskId))?.status).toBe("succeeded");
      expect((await f.tasks.get(nullImage.taskId))?.status).toBe("succeeded");
    });
    expect(f.adapter.execute).toHaveBeenCalledTimes(2);
    expect(f.adapter.execute.mock.calls[0][0].inputs).not.toHaveProperty("image");
    expect(f.adapter.execute.mock.calls[1][0].inputs).not.toHaveProperty("image");
    expect(saveInput).not.toHaveBeenCalled();
  });

  it("图片编辑保留有序多图并拒绝超出 Grok 数量限制", async () => {
    const f = await fixture();
    await f.interfaces.update(f.item.id, { ...f.item, capability: "image-edit" }, (await f.interfaces.list()).revision);
    await writeFile(join(f.workspaces, "agent-a", "first.png"), "first");
    await writeFile(join(f.workspaces, "agent-a", "second.png"), "second");
    const detail = await f.service.list(context, { interfaceId: f.item.id });
    expect(detail.interfaces[0]).toHaveProperty("fields", expect.arrayContaining([
      expect.objectContaining({ name: "image", multiple: true, maxItems: 16 }),
    ]));
    const task = await f.run(context, { ...f.submit("multi-openai"), parameters: [
      { name: "prompt", value: "组合" }, { name: "image", value: ["first.png", "second.png"] },
    ] });
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    expect((f.adapter.execute.mock.calls[0][0].inputs.image as { name: string }[]).map((asset) => asset.name))
      .toEqual(["first.png", "second.png"]);
    await expect(f.run(context, { ...f.submit("invalid-image"), parameters: [
      { name: "prompt", value: "组合" }, { name: "image", value: ["first.png", "missing.png"] },
    ] })).rejects.toThrow();
    await f.interfaces.update(f.item.id, { ...f.item, protocol: "grok", capability: "image-edit",
      channelId: "grok-channel", config: { model: "grok-imagine" } }, (await f.interfaces.list()).revision);
    await expect(f.run(context, { ...f.submit("too-many"), parameters: [
      { name: "prompt", value: "组合" }, { name: "image", value: Array(6).fill("first.png") },
    ] })).rejects.toThrow("媒体引用无效");
  });

  it("Grok 媒体字段统一接收本地路径并自动发布为稳定 URL", async () => {
    const f = await fixture();
    await f.interfaces.update(f.item.id, {
      ...f.item,
      protocol: "grok",
      capability: "image-edit",
      channelId: "grok-channel",
      config: { model: "grok-imagine" },
    }, (await f.interfaces.list()).revision);
    await writeFile(join(f.workspaces, "agent-a", "source.png"), "png");
    await expect(f.run(context, {
      ...f.submit("grok-null-image"),
      parameters: [{ name: "prompt", value: "x" }, { name: "image", value: null }],
    })).rejects.toThrow("缺少必填参数 image");
    const detail = await f.service.list(context, { interfaceId: f.item.id });
    expect(detail.interfaces[0]).toHaveProperty("fields", expect.arrayContaining([
      expect.objectContaining({ name: "image", source: "workspace" }),
    ]));
    const task = await f.run(context, {
      ...f.submit(),
      parameters: [{ name: "prompt", value: "x" }, { name: "image", value: "source.png" }],
    });
    await vi.waitFor(async () => expect((await f.tasks.get(task.taskId))?.status).toBe("succeeded"));
    const publicFiles = await f.publicFiles.list();
    expect(publicFiles).toHaveLength(1);
    expect(f.adapter.execute.mock.calls[0][0].inputs.image).toBe(`https://bugpaw.example/aigc-public/files/${publicFiles[0].id}`);
    expect(await f.publicFiles.resolvePath(publicFiles[0].id)).toBeTruthy();
    await writeFile(join(f.workspaces, "agent-a", "second.png"), "second");
    const multi = await f.run(context, { ...f.submit("grok-multi"), parameters: [
      { name: "prompt", value: "组合" }, { name: "image", value: ["source.png", "second.png"] },
    ] });
    await vi.waitFor(async () => expect((await f.tasks.get(multi.taskId))?.status).toBe("succeeded"));
    const published = await f.publicFiles.list();
    const references = f.adapter.execute.mock.calls[1][0].inputs.image as string[];
    expect(references.map((url) => published.find((file) => url.endsWith(`/${file.id}`))?.name.split("-").at(-1)))
      .toEqual(["source.png", "second.png"]);
  });

  it("Grok 缺少公开 Origin 时拒绝提交且不残留公开文件", async () => {
    const f = await fixture(undefined, undefined, null);
    await f.interfaces.update(f.item.id, {
      ...f.item,
      protocol: "grok",
      capability: "image-edit",
      channelId: "grok-channel",
      config: { model: "grok-imagine" },
    }, (await f.interfaces.list()).revision);
    await writeFile(join(f.workspaces, "agent-a", "source.png"), "png");
    await expect(f.run(context, {
      ...f.submit(),
      parameters: [{ name: "prompt", value: "x" }, { name: "image", value: "source.png" }],
    })).rejects.toMatchObject({ code: "AIGC_PUBLIC_ORIGIN_UNAVAILABLE" });
    expect(await f.tasks.listRecords()).toHaveLength(0);
    expect(await f.publicFiles.list()).toHaveLength(0);
  });

  it("工具错误不泄露底层绝对路径或凭据", async () => {
    const f = await fixture();
    vi.spyOn(f.service, "list").mockRejectedValue(new Error("Bearer secret /private/path"));
    const params = { action: "list" as const, interfaceId: null, offset: 0 };
    await expect(f.tools[0].execute("call", params, undefined, undefined, {} as never)).rejects.toThrow("AIGC_OPERATION_FAILED");
    try { await f.tools[0].execute("call", params, undefined, undefined, {} as never); } catch (error) {
      expect(String(error)).not.toContain("secret");
      expect(String(error)).not.toContain("/private");
    }
  });

  it("重启中断任务不自动重试，历史手动任务不被归入 Agent", async () => {
    const f = await fixture(pending);
    const task = await f.run(context, f.submit());
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    const restarted = new AigcTaskRepository(join(f.root, "tasks.json"));
    expect(await restarted.get(task.taskId)).toMatchObject({ status: "failed", error: { code: "AIGC_INTERRUPTED" } });
    expect(f.adapter.execute).toHaveBeenCalledOnce();
  });

  it("取消后迟到的成功响应不能覆盖取消状态或写出产物", async () => {
    let finish: (result: AigcExecutionResult) => void = () => undefined;
    const f = await fixture(async () => new Promise((resolve) => { finish = resolve; }));
    const task = await f.run(context, f.submit());
    await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledOnce());
    const cancellation = f.service.cancel(context, task.taskId);
    await vi.waitFor(() => expect(f.adapter.execute.mock.calls[0][0].signal.aborted).toBe(true));
    finish({ assets: [{ name: "late.png", mediaType: "image/png", content: Buffer.from("late") }] });
    expect(await cancellation).toMatchObject({ status: "cancelled", upstreamCancellation: "unknown" });
    expect((await f.tasks.get(task.taskId))?.assets).toHaveLength(0);
  });

  it("ComfyUI 枚举、布尔、数值范围和默认值按真实字段校验", async () => {
    const f = await fixture();
    const workflow = {
      nodes: [], edges: [], inputMappings: [
        { name: "seed", type: "int", required: true, defaultValue: 10, nodeId: "1", field: "inputs.seed" },
        { name: "mode", type: "enum", enumOptions: [0, 1], required: true, nodeId: "1", field: "inputs.mode" },
        { name: "enabled", type: "bool", required: true, nodeId: "1", field: "inputs.enabled" },
      ],
    } as unknown as AigcWorkflowDetail;
    const fields = agentFields({ ...f.item, protocol: "comfyui" }, workflow);
    expect(validateAgentParameters(fields, [{ name: "mode", value: 0 }, { name: "enabled", value: false }])).toEqual({ seed: 10, mode: 0, enabled: false });
    await expect(f.run(context, f.submit(), AbortSignal.abort())).rejects.toThrow();
    expect(f.adapter.execute).not.toHaveBeenCalled();
  });
});

it("手动与 Agent 共用全局队列，排队任务跨重启恢复且取消不请求上游", async () => {
  const limits = { maxActiveTasks: 1, maxActiveTasksPerAgent: 1, maxHourlyTasksPerAgent: 20, queryIntervalMs: 1000 };
  const f = await fixture(pending, limits);
  const manual = await f.tasks.createRun({ interfaceId: f.item.id, inputs: { prompt: "manual" } });
  await vi.waitFor(() => expect(f.adapter.execute).toHaveBeenCalledTimes(1));
  const agent = await f.run(context, f.submit("queued-agent"));
  const cancelled = await f.tasks.createRun({ interfaceId: f.item.id, inputs: { prompt: "cancelled" } });
  expect(await f.tasks.get(agent.taskId)).toMatchObject({ status: "queued", queueReason: expect.stringContaining("全局并发") });
  await f.tasks.cancel(cancelled.id);
  expect((await f.tasks.get(cancelled.id))?.upstreamCancellation).toBe("confirmed");
  await f.tasks.close();
  const execute = vi.fn(async () => ({ assets: [] }));
  const restarted = new AigcTaskService({
    repository: new AigcTaskRepository(join(f.root, "tasks.json")), interfaces: f.interfaces, workflows: f.workflows,
    connections: f.connections, credentials: new CredentialService(join(f.root, "auth.json")),
    assets: f.assets, publicFiles: f.publicFiles, adapters: { openai: { execute } },
  }, limits);
  try {
    await restarted.initialize();
    await vi.waitFor(async () => expect((await restarted.get(agent.taskId))?.status).toBe("succeeded"));
    expect(execute).toHaveBeenCalledOnce();
    expect((await restarted.get(manual.id))?.status).toBe("cancelled");
    expect((await restarted.get(cancelled.id))?.status).toBe("cancelled");
  } finally { await restarted.close(); }
});
