// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Fastify from "fastify";
import { expect, it } from "vitest";
import { emptyWorkflow, type WorkflowDefinition } from "../../shared/workflow-contracts";
import { projectAigcTemplate } from "../aigc/aigc-manual-creation";
import { DomainError } from "../core/errors";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { registerApiV1Namespace } from "../http/api-versioning";
import { registerApiErrorHandler } from "../http/error-handler";
import { registerRunTemplateRoutes } from "../routes/run-templates";
import { RunTemplateRepository } from "./run-template-repository";
import { projectWorkflowTemplate } from "./workflow-template";

const publicUrl = (id: string) => "https://example.test/aigc-public/files/" + id;

it("两端模板隔离、原子替换、重启持久化和只读回填", async () => {
  const root = await mkdtemp(join(tmpdir(), "run-templates-"));
  const path = join(root, "app.db");
  let db = openDatabase(path);
  const app = Fastify();
  try {
    runMigrations(db, { throughVersion: 10 });
    runMigrations(db);
    registerApiErrorHandler(app);
    registerApiV1Namespace(app);
    const repo = new RunTemplateRepository(db);
    let authenticated = false;
    let available = true;
    const auth = { isAuthenticated: async () => authenticated } as never;
    const def = { ...emptyWorkflow(), name: "翻译", id: "target" } as WorkflowDefinition;
    const fields = def.nodes[0].outputs;
    fields.push({ name: "scale", type: "float" }, { name: "flag", type: "boolean" },
      { name: "tags", type: "string", multiple: true }, { name: "optional", type: "string" });
    registerRunTemplateRoutes(app, auth, repo, "workflow", {
      list: async () => available ? [def] : [],
      project: async (id, inputs, previous) => {
        if (!available || def.id !== id) throw new DomainError("NOT_FOUND", "工作流不存在");
        return projectWorkflowTemplate(def, {} as never, {} as never, inputs, previous);
      },
    });
    const channel = { id: "grok", enabled: true };
    const item = { ...def, protocol: "grok", capability: "text-to-image", config: {}, channelId: channel.id, enabled: true };
    registerRunTemplateRoutes(app, auth, repo, "aigc", {
      list: async () => [item],
      project: (id, inputs, previous) => projectAigcTemplate({ interfaces: { get: async () => item } } as never,
        { read: async () => ({ channels: [channel] }) } as never, id, inputs, publicUrl, previous),
    });
    const wf = "/api/v1/workflows/run-templates";
    const ai = "/api/v1/aigc/run-templates";
    for (const url of [wf, ai]) {
      for (const [method, suffix] of [["GET",""],["GET","/x/draft"],["POST",""],["PUT","/x"],["PATCH","/x"],["DELETE","/x"]] as const) {
        expect((await app.inject({ method, url: url + suffix })).statusCode).toBe(401);
      }
    }
    authenticated = true;
    const inputs = { scale: 0, flag: false, tags: [], optional: null };
    const payload = { targetId: def.id, name: "  常用 ", inputs, count: 3, requestKey: "ignored" };
    const post = await app.inject({ method: "POST", url: wf, payload });
    expect(post.statusCode).toBe(201);
    const url = wf + "/" + post.json().id;
    expect(post.json().name).toBe("常用");
    expect((await app.inject({ method: "POST", url: wf, payload })).json().error)
      .toMatchObject({ code: "RUN_TEMPLATE_CONFLICT", message: "当前运行对象已有同名模板", requestId: expect.any(String) });
    const grok = await app.inject({ method: "POST", url: ai, payload: { ...payload, inputs: { count: 4 } } });
    expect(grok.statusCode).toBe(201);
    const aigcUrl = ai + "/" + grok.json().id;
    expect((await app.inject(aigcUrl + "/draft")).json()).toMatchObject({ count: 1, inputs: { count: 4 }, issues: [] });
    channel.enabled = false;
    expect((await app.inject(aigcUrl + "/draft")).statusCode).toBe(409);
    expect((await app.inject(ai + "/" + post.json().id + "/draft")).statusCode).toBe(404);
    expect((await app.inject({ method: "PUT", url, payload: { ...payload, targetId: "other" } })).statusCode).toBe(409);
    for (const bad of [{ flag: "false" }, { x: 7 }, { optional: "https://example.invalid/?signature=example" }]) {
      expect((await app.inject({ method: "PUT", url, payload: { ...payload, inputs: bad } })).statusCode).toBe(400);
    }
    expect((await app.inject(url + "/draft")).json()).toEqual({ targetId: def.id, inputs, issues: [], count: 1 });
    const update = { scale: 2, tags: ["first", "second"] };
    expect((await app.inject({ method: "PUT", url, payload: { ...payload, inputs: update } })).json().name).toBe("常用");
    fields.find(f => f.name === "scale")!.type = "integer";
    def.name = "翻译二版";
    expect((await app.inject(wf)).json().templates[0].targetName).toBe(def.name);
    const draft = await app.inject(url + "/draft");
    expect(draft.headers["cache-control"]).toBe("no-store");
    expect(draft.json()).toMatchObject({ inputs: { tags: update.tags }, issues: [{ field: "scale" }], count: 1 });
    expect(Object.keys(draft.json().inputs)).toEqual(["tags"]);
    available = false;
    expect((await app.inject(url + "/draft")).statusCode).toBe(404);
    expect((await app.inject({ method: "PATCH", url, payload: { name: "留档" } })).json().name).toBe("留档");
    expect((await app.inject({ method: "DELETE", url })).statusCode).toBe(204);
    db.close();
    db = openDatabase(path);
    runMigrations(db);
    const restored = new RunTemplateRepository(db);
    expect(restored.list("workflow")).toEqual([]);
    expect(restored.get("aigc", grok.json().id).snapshot.inputs).toEqual({ count: 4 });
  } finally {
    await app.close();
    db.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("数组原件失效时只保留仍可解析的引用，顺序稳定", async () => {
  const def = emptyWorkflow() as WorkflowDefinition;
  def.nodes[0].outputs = [{ name: "refs", type: "image", multiple: true }];
  const file = (assetId: string) => ({ assetId, name: "同名图片", mediaType: "image/png", size: 1 });
  const files = { resolve: async (value: {assetId: string}) => {
    if (value.assetId === "missing") throw new DomainError("INVALID_ATTACHMENT", "工作流文件内容已不存在");
    return { file: file(value.assetId) };
  } };
  const saved = { refs: [file("b"), file("missing"), file("a")] };
  const result = await projectWorkflowTemplate(def, files as never, {} as never, saved, { inputs: saved, types: { refs: "image[]" } });
  expect(result.snapshot.inputs.refs).toEqual([file("b"), file("a")]);
  expect(result.issues).toEqual([{ field: "refs", message: "工作流文件内容已不存在" }]);
});

it("ComfyUI 渠道地址变化后拒绝同名文件，保留兼容参数", async () => {
  const channel = { id: "local", baseUrl: "https://first.example", enabled: true };
  const item = { id: "interface", name: "绘图", protocol: "comfyui", channelId: channel.id, enabled: true, config: { workflowId: "graph" } };
  const workflow = { nodes: [{ id: "1", type: "LoadImage", fields: [] }], inputMappings: [
    { name: "image", type: "image", nodeId: "1", field: "image" },
    { name: "steps", type: "int", nodeId: "1", field: "steps" },
  ] };
  const source = { filename: "example.png", name: "example.png", mediaType: "image/png" };
  const deps = { interfaces: { get: async () => item }, workflows: { exists: async () => true, get: async () => ({ workflow }) },
    comfyuiInputs: { list: async () => [source] } } as never;
  const connections = { read: async () => ({ channels: [channel] }) } as never;
  const saved = await projectAigcTemplate(deps, connections, item.id, { image: { ...source, source: "comfyui_input" }, steps: 0 }, publicUrl);
  expect(saved.issues).toEqual([]);
  channel.baseUrl = "https://second.example";
  const restored = await projectAigcTemplate(deps, connections, item.id, saved.snapshot.inputs, publicUrl, saved.snapshot);
  expect(restored.snapshot.inputs).toEqual({ steps: 0 });
  expect(restored.issues).toMatchObject([{ field: "image" }]);
});

it("Grok 复核公开文件来源、类型和存在性，失效项不替换为同名文件", async () => {
  const item = { id: "edit", name: "编辑", protocol: "grok", capability: "image-edit", config: {}, enabled: true, channelId: "g" };
  const connections = { read: async () => ({ channels: [{ id: "g", enabled: true }] }) } as never;
  const ids = new Set(["a","b"]);
  const deps = { interfaces: { get: async () => item }, publicFiles: { get: async () => ({ mediaType: "image/png" }),
    resolvePath: async (id: string) => ids.has(id) ? id : undefined } } as never;
  const foreign = await projectAigcTemplate(deps, connections, item.id, { image: publicUrl("a").replace("example.test", "other.test") }, publicUrl);
  expect(foreign.issues).toMatchObject([{ field: "image" }]);
  const saved = await projectAigcTemplate(deps, connections, item.id, { image: [publicUrl("b"), publicUrl("a")] }, publicUrl);
  expect(saved.issues).toEqual([]);
  ids.delete("b");
  const opened = await projectAigcTemplate(deps, connections, item.id, saved.snapshot.inputs, publicUrl, saved.snapshot);
  expect(opened.snapshot.inputs.image).toEqual([publicUrl("a")]);
  expect(opened.issues).toMatchObject([{ field: "image" }]);
});
