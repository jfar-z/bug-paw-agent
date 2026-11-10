import { createTestDatabase } from "../database/test-database";
// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  emptyWorkflow,
  newWorkflowNode,
  type WorkflowDraft,
} from "../../shared/workflow-contracts";
import { WorkflowService, type WorkflowExecutor } from "./workflow-service";
import { WorkflowRepository } from "./workflow-repository";
import {
  validateWorkflow,
  validateValues,
  checkCustomParameters,
} from "./workflow-validation";
import { runWorkflowScript } from "./workflow-script";
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});
async function fixture(
  executor: WorkflowExecutor = { execute: async () => ({ text: "完成" }) },
) {
  const root = await mkdtemp(join(tmpdir(), "bugpaw-workflow-test-"));
  const repository = new WorkflowRepository(root, createTestDatabase()),
    service = new WorkflowService(repository, executor);
  await service.initialize();
  cleanup.push(async () => {
    await service.close();
    await rm(root, { recursive: true, force: true });
  });
  return { service, repository };
}
const ref = (nodeId: string, field = "result") => ({
  kind: "reference" as const,
  nodeId,
  field,
});
/** 完整分支使用真正的脚本和持久化，只有远端能力被替换。 */
function branched(): WorkflowDraft {
  const d = emptyWorkflow(),
    condition = newWorkflowNode("condition", "condition"),
    yes = newWorkflowNode("javascript", "yes"),
    no = newWorkflowNode("javascript", "no"),
    select = newWorkflowNode("select", "select");
  condition.config.conditions = [
    {
      left: ref("input", "prompt"),
      operator: "eq",
      right: { kind: "literal", value: "yes" },
    },
  ];
  yes.config.script = 'return {result:"YES"}';
  no.config.script = 'throw new Error("未激活分支不应运行")';
  select.config.candidates = [ref("yes"), ref("no")];
  d.nodes = [d.nodes[0], condition, yes, no, select, d.nodes[1]];
  d.nodes.at(-1)!.inputs.result = ref("select");
  d.edges = [
    { id: "a", source: "input", target: "condition" },
    { id: "b", source: "condition", target: "yes", branch: "true" },
    { id: "c", source: "condition", target: "no", branch: "false" },
    { id: "d", source: "yes", target: "select" },
    { id: "e", source: "no", target: "select" },
    { id: "f", source: "select", target: "output" },
  ];
  return d;
}
/** 两条互斥路径直接进入输出，分别绑定可选字段，不经过选择节点。 */
function outputBranched(): WorkflowDraft {
  const draft = branched();
  draft.nodes = draft.nodes.filter((node) => node.id !== "select");
  draft.nodes.find((node) => node.id === "no")!.config.script = 'return {result:"NO"}';
  const output = draft.nodes.at(-1)!;
  output.inputs = { result: ref("yes"), return_payload: ref("no") };
  output.outputs = [
    { name: "result", type: "string" },
    { name: "return_payload", type: "string" },
  ];
  draft.edges = draft.edges.filter((edge) => edge.source !== "select").map((edge) =>
    edge.target === "select" ? { ...edge, target: "output" } : edge,
  );
  return draft;
}
describe("工作流调度与持久化", () => {
  it("画布设置按工作流保存并恢复，旧定义兼容且不进入列表摘要", async () => {
    const { service, repository } = await fixture();
    const draft = emptyWorkflow();
    draft.editorSettings = { snapToGrid: true, snapToNodes: false };
    const first = await service.save(draft);
    const legacy = emptyWorkflow();
    delete legacy.editorSettings;
    const second = await service.save(legacy);
    expect(repository.definition(first.id)?.editorSettings).toEqual(draft.editorSettings);
    expect(repository.definition(second.id)?.editorSettings).toBeUndefined();
    expect(repository.definitions().every((item) => !("editorSettings" in item))).toBe(true);
    await service.save({ ...first, editorSettings: { snapToGrid: false, snapToNodes: true } }, first.id, first.revision);
    expect(repository.definition(first.id)?.editorSettings).toEqual({ snapToGrid: false, snapToNodes: true });
    expect(repository.definition(second.id)?.editorSettings).toBeUndefined();
  });
  it.each([null, {}, { snapToGrid: "true", snapToNodes: true }, { snapToGrid: true, snapToNodes: false, extra: 1 }])(
    "拒绝非法画布配置 %j 并保留明确校验错误", (editorSettings) => {
      expect(() => validateWorkflow({ ...emptyWorkflow(), editorSettings } as unknown as WorkflowDraft))
        .toThrow("工作流画布设置必须包含布尔类型的网格吸附和节点对齐开关");
    },
  );
  it.each(["yes", "no"])("输出直接汇合互斥分支并省略未执行来源（%s）", async (prompt) => {
    const { service } = await fixture();
    const saved = await service.save(outputBranched());
    const started = await service.start(saved.id, { prompt }, "direct-merge");
    const done = await service.wait(started.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual(prompt === "yes" ? { result: "YES" } : { return_payload: "NO" });
    expect(done.nodes.find((node) => node.nodeId === "output")?.status).toBe("succeeded");
    expect(done.nodes.find((node) => node.nodeId === (prompt === "yes" ? "no" : "yes"))?.status).toBe("skipped");
  });

  it.each(["yes", "no"])("视频产出与判断 ELSE 直接汇合到输出（%s）", async (prompt) => {
    const video = { assetId: "test-video", name: "result.mp4", mediaType: "video/mp4", size: 10 };
    const execute = vi.fn(async () => ({ result: [video] }));
    const { service } = await fixture({ execute });
    const draft = outputBranched();
    draft.nodes = draft.nodes.filter((node) => node.id !== "no");
    const generator = draft.nodes.find((node) => node.id === "yes")!;
    generator.kind = "aigc";
    generator.inputs = {};
    generator.config = { interfaceId: "test-interface" };
    generator.outputs = [{ name: "result", type: "video", multiple: true }];
    const output = draft.nodes.at(-1)!;
    output.outputs[0] = { name: "result", type: "video", multiple: true };
    output.inputs.return_payload = ref("input", "prompt");
    draft.edges = draft.edges.filter((edge) => edge.source !== "no").map((edge) =>
      edge.target === "no" ? { ...edge, target: "output" } : edge,
    );
    const saved = await service.save(draft);
    const started = await service.start(saved.id, { prompt }, "video-merge");
    const done = await service.wait(started.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual(prompt === "yes" ? { result: [video], return_payload: prompt } : { return_payload: prompt });
    expect(execute).toHaveBeenCalledTimes(prompt === "yes" ? 1 : 0);
  });

  it("输出汇合保留显式默认值，必填来源被跳过仍带节点与追踪信息报错", async () => {
    const { service } = await fixture();
    const draft = outputBranched();
    draft.nodes.at(-1)!.outputs[0].defaultValue = "";
    const saved = await service.save(draft);
    const started = await service.start(saved.id, { prompt: "no" }, "default");
    expect((await service.wait(started.id)).outputs).toEqual({ result: "", return_payload: "NO" });
    delete draft.nodes.at(-1)!.outputs[0].defaultValue;
    draft.nodes.at(-1)!.outputs[0].required = true;
    const required = await service.save(draft);
    const missing = await service.start(required.id, { prompt: "no" }, "required");
    const done = await service.wait(missing.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatchObject({ code: "VALIDATION_FAILED", message: "必填参数 result 未提供", nodeId: "output", requestId: missing.id });
  });

  it.each([false, true])("输出等待全部并行前驱且不吞掉迟到失败（失败=%s）", async (fail) => {
    let resolve!: (value: Record<string, unknown>) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<Record<string, unknown>>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    const { service } = await fixture({ execute: () => pending });
    const draft = outputBranched();
    const slow = newWorkflowNode("llm", "slow");
    slow.config.provider = "test";
    slow.config.modelId = "test";
    slow.inputs.prompt = ref("input", "prompt");
    draft.nodes.splice(-1, 0, slow);
    draft.nodes.at(-1)!.outputs.push({ name: "slow", type: "string", required: true });
    draft.nodes.at(-1)!.inputs.slow = ref("slow", "text");
    draft.edges.push({ id: "slow-in", source: "condition", target: "slow", branch: "true" }, { id: "slow-out", source: "slow", target: "output" });
    const saved = await service.save(draft);
    const started = await service.start(saved.id, { prompt: "yes" }, "parallel-merge");
    try {
      await vi.waitFor(() => {
        const run = service.getRun(started.id);
        expect(run.nodes.find((node) => node.nodeId === "slow")?.status).toBe("running");
        expect(run.nodes.find((node) => node.nodeId === "yes")?.status).toBe("succeeded");
        expect(run.nodes.find((node) => node.nodeId === "output")?.status).toBe("queued");
        expect(run.outputs).toEqual({});
      });
    } finally {
      if (fail) reject(new Error("并行模型生成失败"));
      else resolve({ text: "慢分支完成" });
    }
    const done = await service.wait(started.id);
    if (fail) {
      expect(done.status).toBe("failed");
      expect(done.error).toMatchObject({ message: "并行模型生成失败", nodeId: "slow", requestId: started.id });
      expect(done.nodes.find((node) => node.nodeId === "output")?.status).toBe("cancelled");
    } else {
      expect(done.status).toBe("succeeded");
      expect(done.outputs).toEqual({ result: "YES", slow: "慢分支完成" });
    }
  });

  it("输出所有入边未激活时明确报错，不返回空成功", async () => {
    const { service } = await fixture();
    const draft = outputBranched();
    draft.nodes = draft.nodes.filter((node) => node.id !== "no");
    draft.edges = draft.edges.filter((edge) => edge.source !== "no" && edge.target !== "no");
    delete draft.nodes.at(-1)!.inputs.return_payload;
    const saved = await service.save(draft);
    const started = await service.start(saved.id, { prompt: "no" }, "inactive");
    const done = await service.wait(started.id);
    expect(done.status).toBe("failed");
    expect(done.error).toMatchObject({ code: "WORKFLOW_EXECUTION_FAILED", message: "输出节点未被执行：没有已激活的入边，请检查分支到输出节点的连线", requestId: started.id });
  });

  it("被调用工作流同样直接汇合互斥分支", async () => {
    const { service } = await fixture();
    const child = await service.save(outputBranched());
    const draft = emptyWorkflow();
    const call = newWorkflowNode("workflow", "call");
    call.config.workflowId = child.id;
    call.inputs.prompt = ref("input", "prompt");
    call.outputs = structuredClone(child.nodes.at(-1)!.outputs);
    draft.nodes[1].outputs = structuredClone(call.outputs);
    draft.nodes[1].inputs = { result: ref("call"), return_payload: ref("call", "return_payload") };
    draft.nodes.splice(1, 0, call);
    draft.edges = [{ id: "in", source: "input", target: "call" }, { id: "out", source: "call", target: "output" }];
    const saved = await service.save(draft);
    const started = await service.start(saved.id, { prompt: "no" }, "nested");
    const done = await service.wait(started.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ return_payload: "NO" });
  });

  it("保存和启动旧定义时拒绝未声明的输出绑定，修正后正常输出且不调用外部能力", async () => {
    const execute = vi.fn();
    const { service, repository } = await fixture({ execute });
    const draft = emptyWorkflow();
    draft.nodes[1].outputs = [{ name: "story", type: "string", required: true }];
    draft.nodes[1].inputs.story = ref("input", "prompt");
    await expect(service.save(draft)).rejects.toMatchObject({
      code: "VALIDATION_FAILED", message: expect.stringContaining("输出绑定 result 未声明"),
    });
    delete draft.nodes[1].inputs.result;
    const saved = await service.save(draft);
    const legacy = structuredClone(saved);
    legacy.nodes[1].inputs.result = ref("input", "prompt");
    repository.mutateDefinition(saved.id, () => ({ value: legacy, result: undefined }));
    await expect(service.start(saved.id, { prompt: "已生成文本" }, "stale-output"))
      .rejects.toMatchObject({ code: "VALIDATION_FAILED", message: expect.stringContaining("输出绑定 result 未声明") });
    expect(service.listRuns()).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    await service.save(saved, saved.id, saved.revision);
    const started = await service.start(saved.id, { prompt: "已生成文本" }, "fixed-output");
    expect((await service.wait(started.id)).outputs).toEqual({ story: "已生成文本" });
  });

  it("默认输入输出运行，幂等重试、快照和版本冲突", async () => {
    const { service, repository } = await fixture();
    const d = await service.save(emptyWorkflow());
    const [a, b] = await Promise.all([
      service.start(d.id, { prompt: "hello" }, "same"),
      service.start(d.id, { prompt: "hello" }, "same"),
    ]);
    expect(a.id).toBe(b.id);
    const done = await service.wait(a.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: "hello" });
    await expect(
      service.start(d.id, { prompt: "changed" }, "same"),
    ).rejects.toThrow("requestKey");
    await service.save({ ...d, name: "新版本" }, d.id, d.revision);
    await expect(service.save(d, d.id, d.revision)).rejects.toThrow("其他页面");
    expect(service.getRun(a.id).definition.name).toBe(d.name);
    expect((await repository.runs())[0].outputs).toEqual({ result: "hello" });
  });
  it("互斥分支跳过并通过选择节点汇合", async () => {
    const { service } = await fixture();
    const d = await service.save(branched());
    const run = await service.start(d.id, { prompt: "yes" }, "branch");
    const done = await service.wait(run.id);
    expect(done.status).toBe("succeeded");
    expect(done.outputs).toEqual({ result: "YES" });
    expect(done.nodes.find((n) => n.nodeId === "no")?.status).toBe("skipped");
    expect(done.nodes.every((n) => n.events.length > 0)).toBe(true);
  });
  it("单个节点失败立即中止并行节点且终态仍为失败", async () => {
    const execute = vi.fn(async ({ node, signal }) => {
      if (node.id === "bad") throw new Error("受控上游失败");
      await new Promise<void>((_, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      });
      return { text: "不应完成" };
    });
    const { service } = await fixture({ execute });
    const d = emptyWorkflow(),
      bad = newWorkflowNode("llm", "bad"),
      slow = newWorkflowNode("llm", "slow");
    for (const n of [bad, slow]) {
      n.config.provider = "test";
      n.config.modelId = "model";
      n.inputs.prompt = ref("input", "prompt");
    }
    d.nodes.splice(1, 0, bad, slow);
    d.nodes.at(-1)!.inputs.result = ref("bad", "text");
    d.edges = [
      { id: "a", source: "input", target: "bad" },
      { id: "b", source: "input", target: "slow" },
      { id: "c", source: "bad", target: "output" },
      { id: "d", source: "slow", target: "output" },
    ];
    const saved = await service.save(d);
    const started = await service.start(
      saved.id,
      { prompt: "test" },
      "parallel",
    );
    const done = await service.wait(started.id);
    expect(done.status).toBe("failed");
    expect(done.error?.message).toContain("受控上游失败");
    expect(done.nodes.find((n) => n.nodeId === "slow")?.status).toBe(
      "cancelled",
    );
  });
  it("取消活动脚本、拒绝跨 Agent 任务访问，重启不重试付费节点", async () => {
    const { service, repository } = await fixture();
    const d = emptyWorkflow(),
      script = newWorkflowNode("javascript", "script");
    script.config.script = "while(true){}";
    script.config.timeoutMs = 5000;
    d.published = true;
    d.nodes.splice(1, 0, script);
    d.nodes.at(-1)!.inputs.result = ref("script");
    d.edges = [
      { id: "a", source: "input", target: "script" },
      { id: "b", source: "script", target: "output" },
    ];
    const saved = await service.save(d),
      origin = { agentId: "a", sessionId: "s" };
    const run = await service.start(
      saved.id,
      { prompt: "hello" },
      "cancel",
      origin,
    );
    expect(() =>
      service.getRun(run.id, { agentId: "b", sessionId: "s" }),
    ).toThrow("无权");
    expect((await service.cancel(run.id, origin)).status).toBe("cancelled");
    const interrupted = {
      ...service.getRun(run.id),
      status: "running" as const,
    };
    await repository.saveRun(interrupted);
    const recovered = new WorkflowService(repository, { execute: vi.fn() });
    await recovered.initialize();
    expect(recovered.getRun(run.id).error?.code).toBe("WORKFLOW_INTERRUPTED");
  });
});
describe("类型与 DAG 验证", () => {
  it.each([false, true])("递归拒绝循环体未声明的输出映射（runnable=%s），不限制脚本自由输入", (runnable) => {
    const draft = emptyWorkflow();
    const script = newWorkflowNode("javascript", "script");
    script.inputs.custom = { kind: "literal", value: 0 };
    draft.nodes.splice(1, 0, script);
    draft.edges = [
      { id: "in", source: "input", target: "script" },
      { id: "out", source: "script", target: "output" },
    ];
    expect(() => validateWorkflow(draft, runnable)).not.toThrow();
    const loop = newWorkflowNode("loop", "loop");
    loop.config.loop!.body.nodes[1].inputs.stale = { kind: "literal", value: undefined };
    draft.nodes.push(loop);
    expect(() => validateWorkflow(draft, runnable)).toThrow("输出绑定 stale 未声明");
  });

  it("拒绝环路、非上游引用、悬空和输出类型不兼容", () => {
    const d = branched();
    d.edges.push({ id: "cycle", source: "select", target: "condition" });
    expect(() => validateWorkflow(d, true)).toThrow("环路");
    const e = emptyWorkflow();
    e.nodes[1].inputs.result = ref("absent");
    expect(() => validateWorkflow(e, true)).toThrow("非上游");
    const f = emptyWorkflow();
    f.nodes[1].outputs[0].type = "integer";
    expect(() => validateWorkflow(f, true)).toThrow("类型不兼容");
    const g = emptyWorkflow();
    g.nodes.push(newWorkflowNode("javascript", "unused"));
    expect(() => validateWorkflow(g, true)).toThrow("未连接");
  });
  it("保留 0/false，拒绝数值、媒体类型和自定义身份参数错误", () => {
    expect(
      validateValues(
        [
          { name: "count", type: "integer", required: true },
          { name: "enabled", type: "boolean", required: true },
        ],
        { count: 0, enabled: false },
      ),
    ).toEqual({ count: 0, enabled: false });
    expect(() =>
      validateValues([{ name: "n", type: "integer" }], { n: 1.1 }),
    ).toThrow("integer");
    expect(() =>
      validateValues([{ name: "image", type: "image" }], {
        image: { assetId: "x", mediaType: "audio/wav" },
      }),
    ).toThrow("image");
    for (const key of [
      "model",
      "tools",
      "api-key",
      "base_url",
      "contents",
      "config",
    ])
      expect(() => checkCustomParameters({ [key]: "forbidden" })).toThrow(
        "禁止覆盖",
      );
  });
});
describe("JavaScript 沙箱", () => {
  it("转换 JSON 并保留日志，不提供宿主 API", async () => {
    const r = await runWorkflowScript(
      'console.log("step", inputs.n); return {n:inputs.n*2,globals:[typeof process,typeof require,typeof fetch]};',
      { n: 3 },
      1000,
      new AbortController().signal,
    );
    expect(r.output).toEqual({
      n: 6,
      globals: ["undefined", "undefined", "undefined"],
    });
    expect(r.logs).toEqual(["step 3"]);
  });
  it("中断无限循环，拒绝异步、语法错误及内存耗尽", async () => {
    const signal = new AbortController().signal;
    await expect(
      runWorkflowScript("while(true){}", {}, 100, signal),
    ).rejects.toThrow("超时");
    await expect(
      runWorkflowScript("return Promise.resolve({});", {}, 1000, signal),
    ).rejects.toThrow("Promise");
    await expect(
      runWorkflowScript("return {;", {}, 1000, signal),
    ).rejects.toThrow("错误");
    await expect(
      runWorkflowScript(
        'const items=[];while(true)items.push("x".repeat(100000));',
        {},
        1000,
        signal,
      ),
    ).rejects.toThrow();
  }, 15000);
});

/** 类型来源不能成为执行边，枚举仍作为普通字符串在运行中传递。 */
describe("工作流枚举和参考组调度", () => {
  it("输入枚举兼容普通字符串输出，校验默认值和数组元素", async () => {
    const { service } = await fixture();
    const draft = emptyWorkflow();
    draft.nodes[0].outputs[0].enumValues = ["0", "false", "high"];
    draft.nodes[0].outputs[0].defaultValue = "false";
    const saved = await service.save(draft);
    const started = await service.start(saved.id, {}, "enum-default");
    expect((await service.wait(started.id)).outputs).toEqual({
      result: "false",
    });
    await expect(
      service.start(saved.id, { prompt: false }, "bad"),
    ).rejects.toThrow("枚举");
    expect(() =>
      validateValues(
        [
          {
            name: "choices",
            type: "string",
            multiple: true,
            enumValues: ["a"],
          },
        ],
        { choices: ["a", "b"] },
      ),
    ).toThrow("枚举");
  });
  it("下游枚举类型引用不产生环，删除来源或断开连线明确拒绝", () => {
    const draft = emptyWorkflow();
    const aigc = newWorkflowNode("aigc", "aigc");
    aigc.config.interfaceId = "image";
    draft.nodes.splice(1, 0, aigc);
    draft.edges = [
      { id: "a", source: "input", target: "aigc" },
      { id: "b", source: "aigc", target: "output" },
    ];
    draft.nodes[0].outputs[0].enumValues = ["1", "2"];
    draft.nodes[0].outputs[0].enumSource = {
      nodeId: "aigc",
      field: "steps",
      interfaceId: "image",
    };
    expect(() => validateWorkflow(draft, true)).not.toThrow();
    aigc.config.interfaceId = "changed";
    expect(() => validateWorkflow(draft)).toThrow("来源节点或接口已变更");
    aigc.config.interfaceId = "image";
    draft.edges = [];
    expect(() => validateWorkflow(draft)).toThrow("未连接当前节点");
  });
  it.each(["image", "audio", "video"] as const)(
    "%s 可选参考数组缺省、null 和空数组调度及持久化一致，必填参数仍校验",
    async (type) => {
      const execute = vi.fn(async (_context: unknown, _inputs: unknown) => ({
        files: [],
      }));
      const { service, repository } = await fixture({ execute });
      const draft = emptyWorkflow();
      const field = { name: "media", type, multiple: true, required: false };
      draft.nodes[0].outputs.push(field);
      const aigc = newWorkflowNode("aigc", "aigc");
      aigc.config = {
        interfaceId: "media-interface",
        referenceGroups: {
          refs: { mode: "array", binding: ref("input", "media") },
        },
      };
      draft.nodes.splice(1, 0, aigc);
      draft.edges = [
        { id: "a", source: "input", target: "aigc" },
        { id: "b", source: "aigc", target: "output" },
      ];
      const saved = await service.save(draft);
      for (const [index, inputs] of [
        {},
        { media: null },
        { media: [] },
      ].entries()) {
        const run = await service.start(
          saved.id,
          { prompt: "test", ...inputs },
          `empty-${index}`,
        );
        const done = await service.wait(run.id);
        expect(done.status).toBe("succeeded");
        expect(execute.mock.lastCall?.[0]).toMatchObject({
          referenceGroups: { refs: [] },
        });
        const stored = (await repository.runs()).find(
          (item) => item.id === run.id,
        )!;
        expect(
          stored.nodes.find((node) => node.nodeId === "aigc")?.referenceGroups,
        ).toEqual({ refs: [] });
      }
      field.required = true;
      const required = await service.save(draft);
      for (const [index, inputs] of [{}, { media: null }].entries()) {
        await expect(
          service.start(
            required.id,
            { prompt: "test", ...inputs },
            `required-${index}`,
          ),
        ).rejects.toThrow("必填参数 media 未提供");
      }
      expect(execute).toHaveBeenCalledTimes(3);
    },
  );
  it("调度解析参考组上游数组并保存观测数据，非上游引用不能保存", async () => {
    const execute = vi.fn(async (_context: unknown, _inputs: unknown) => ({
      files: [],
    }));
    const { service } = await fixture({ execute });
    const draft = emptyWorkflow();
    draft.nodes[0].outputs.push({
      name: "images",
      type: "image",
      multiple: true,
    });
    const aigc = newWorkflowNode("aigc", "aigc");
    aigc.config = {
      interfaceId: "image",
      referenceGroups: {
        refs: { mode: "array", binding: ref("input", "images") },
      },
    };
    draft.nodes.splice(1, 0, aigc);
    draft.edges = [
      { id: "a", source: "input", target: "aigc" },
      { id: "b", source: "aigc", target: "output" },
    ];
    const image = { assetId: "one", mediaType: "image/png" };
    const saved = await service.save(draft);
    const run = await service.start(
      saved.id,
      { prompt: "test", images: [image] },
      "groups",
    );
    const done = await service.wait(run.id);
    expect(done.status).toBe("succeeded");
    expect(execute.mock.calls[0][0]).toMatchObject({
      referenceGroups: { refs: [image] },
    });
    expect(
      done.nodes.find((n) => n.nodeId === "aigc")?.referenceGroups,
    ).toEqual({ refs: [image] });
    aigc.config.referenceGroups!.refs.binding = ref("output", "result");
    expect(() => validateWorkflow(draft)).toThrow("非上游");
  });
});

/** 信号量测试图使用真实调度器和存储，仅替换外部模型执行。 */
function semaphoreGraph(): WorkflowDraft {
  const draft = emptyWorkflow();
  const acquire = newWorkflowNode("semaphore_acquire", "acquire"); acquire.config.semaphoreCode = "gpu";
  const model = newWorkflowNode("llm", "model"); model.config.provider = "test"; model.config.modelId = "test";
  model.inputs.prompt = { kind: "reference", nodeId: "input", field: "prompt" };
  draft.nodes.splice(1, 0, acquire, model);
  draft.edges = [{ id: "a", source: "input", target: "acquire" }, { id: "b", source: "acquire", target: "model" }, { id: "c", source: "model", target: "output" }];
  return draft;
}
it.each(["success", "failure", "cancel"])("根工作流 %s 后自动释放全部信号量", async (mode) => {
  const { service } = await fixture({ execute: async ({ signal }) => {
    if (mode === "failure") throw new Error("模型测试失败");
    if (mode === "cancel") await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { text: "完成" };
  } });
  await service.saveSemaphore({ code: "gpu", name: "GPU", limit: 1 });
  const definition = await service.save(semaphoreGraph());
  await expect(service.removeSemaphore("gpu", 1)).rejects.toThrow("引用");
  const run = await service.start(definition.id, { prompt: "hello" }, "auto-release");
  if (mode === "cancel") {
    await vi.waitFor(() => expect(service.semaphores.list()[0].used).toBe(1));
    await service.cancel(run.id);
  }
  await vi.waitFor(() => expect(service.getRun(run.id).status).toBe(mode === "success" ? "succeeded" : mode === "failure" ? "failed" : "cancelled"));
  await vi.waitFor(() => expect(service.semaphores.list()[0]).toMatchObject({ used: 0, waiting: [] }));
});
it("等待信号量的分支不阻塞另一个分支释放，节点按依赖继续推进", async () => {
  const { service } = await fixture();
  await service.saveSemaphore({ code: "gpu", name: "GPU", limit: 1 });
  const draft = semaphoreGraph();
  const second = newWorkflowNode("semaphore_acquire", "second"); second.config.semaphoreCode = "gpu";
  const release = newWorkflowNode("semaphore_release", "release"); release.config.semaphoreCode = "gpu";
  draft.nodes.splice(3, 0, second, release);
  draft.edges = [
    { id: "a", source: "input", target: "acquire" },
    { id: "b", source: "acquire", target: "second" },
    { id: "c", source: "acquire", target: "model" },
    { id: "d", source: "model", target: "release" },
    { id: "e", source: "release", target: "output" },
    { id: "f", source: "second", target: "output" },
  ];
  const definition = await service.save(draft);
  const run = await service.start(definition.id, { prompt: "hello" }, "parallel-release");
  await vi.waitFor(() => expect(service.getRun(run.id).status).toBe("succeeded"), { timeout: 3000 });
  expect(service.getRun(run.id).nodes.find((node) => node.nodeId === "second")?.events.some((event) => event.message.includes("已获取"))).toBe(true);
  expect(service.semaphores.list()[0].used).toBe(0);
});
it("超出手动并发额度的任务按提交顺序排队，取消队列不执行且重启恢复未启动项", async () => {
  const entered: string[] = [];
  const { service, repository } = await fixture({ execute: async ({ run, signal }) => {
    entered.push(run.requestKey);
    await new Promise<void>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    return { text: "done" };
  } });
  const draft = semaphoreGraph(); draft.nodes = draft.nodes.filter((node) => node.id !== "acquire");
  draft.edges = [{ id: "a", source: "input", target: "model" }, { id: "b", source: "model", target: "output" }];
  const definition = await service.save(draft);
  const runs: Awaited<ReturnType<WorkflowService["start"]>>[] = [];
  for (let i = 0; i < 5; i++) runs.push(await service.start(definition.id, { prompt: "test" }, `queue-${i}`));
  await vi.waitFor(() => expect(entered).toEqual(["queue-0", "queue-1"]));
  expect(service.getRun(runs[2].id)).toMatchObject({ status: "queued", queueReason: expect.stringContaining("并发额度") });
  await service.cancel(runs[2].id); await service.cancel(runs[0].id);
  await vi.waitFor(() => expect(entered).toEqual(["queue-0", "queue-1", "queue-3"]));
  await service.close();
  const execute = vi.fn(async () => ({ text: "恢复" }));
  const restarted = new WorkflowService(repository, { execute });
  await restarted.initialize();
  await vi.waitFor(() => expect(restarted.getRun(runs[4].id).status).toBe("succeeded"));
  expect(execute).toHaveBeenCalledTimes(1);
  expect(restarted.getRun(runs[2].id).status).toBe("cancelled");
  await restarted.close();
});

it("多个等待分支不能占满节点槽位阻止释放路径", async () => {
  const { service } = await fixture();
  await service.saveSemaphore({ code: "gpu", name: "GPU", limit: 1 });
  const draft = semaphoreGraph();
  const release = newWorkflowNode("semaphore_release", "release"); release.config.semaphoreCode = "gpu";
  const output = draft.nodes.pop()!;
  draft.nodes.push(release);
  draft.edges = [{ id: "a", source: "input", target: "acquire" }, { id: "b", source: "acquire", target: "model" }, { id: "c", source: "model", target: "release" }, { id: "d", source: "release", target: "output" }];
  for (let i = 0; i < 4; i++) {
    const acquire = newWorkflowNode("semaphore_acquire", `wait_${i}`); acquire.config.semaphoreCode = "gpu";
    const release = newWorkflowNode("semaphore_release", `release_${i}`); release.config.semaphoreCode = "gpu";
    draft.nodes.splice(2, 0, acquire, release);
    draft.edges.push({ id: `w_${i}`, source: "acquire", target: acquire.id }, { id: `r_${i}`, source: acquire.id, target: release.id }, { id: `o_${i}`, source: release.id, target: "output" });
  }
  draft.nodes.push(output);
  const definition = await service.save(draft);
  const run = await service.start(definition.id, { prompt: "test" }, "many-waiters");
  await vi.waitFor(() => expect(service.getRun(run.id).status).toBe("succeeded"), { timeout: 3000 });
  expect(service.semaphores.list()[0]).toMatchObject({ used: 0, waiting: [] });
});
