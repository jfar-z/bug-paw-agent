// @vitest-environment node
import { Readable } from "node:stream";
import { Check } from "typebox/value";
import { MediaAccess, mediaReference } from "../media-library/media-access";
import { MediaResults } from "../media-library/media-results";
import { MediaDeleteConfirmations } from "../media-library/media-deletion";
import { createMediaDeleteTool, createMediaTool } from "../media-library/media-tool";
import { AigcAssetService } from "../aigc/aigc-asset-service";
import { WorkflowRepository } from "../workflows/workflow-repository";
import { WorkflowService } from "../workflows/workflow-service";
import { WorkflowFiles } from "../workflows/workflow-files";
import { WorkflowMediaInputs } from "../media-library/workflow-media-inputs";
import { submitMediaInputs } from "../media-library/aigc-media-inputs";
import { emptyWorkflow, newWorkflowNode } from "../../shared/workflow-contracts";
import type { AgentProfile } from "../../shared/agent-contracts";
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { registerApiV1Namespace } from "../http/api-versioning";
import { registerApiErrorHandler } from "../http/error-handler";
import { MediaRepository } from "../media-library/media-repository";
import { MediaStorage } from "../media-library/media-storage";
import { registerMediaLibraryRoutes } from "./media-libraries";
import type { AuthService } from "./auth";

let confirmations: MediaDeleteConfirmations;
let root: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof Fastify>;
let repo: MediaRepository;
let storage: MediaStorage;
let assets: AigcAssetService;
let files: WorkflowFiles;
let workflowOutputs: Record<string, unknown>;
let url: string;
let png: Buffer;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "media-library-"));
  db = openDatabase(join(root, "index.sqlite"));
  runMigrations(db, { throughVersion: 8 });
  runMigrations(db);
  repo = new MediaRepository(db);
  storage = new MediaStorage(join(root, "objects"), repo);
  await storage.recover();
  app = Fastify({ forceCloseConnections: true });
  registerApiV1Namespace(app);
  registerApiErrorHandler(app);
  await app.register(multipart);
  assets = new AigcAssetService(join(root, "aigc"));
  files = new WorkflowFiles(join(root, "dag"), {} as never, {} as never);
  workflowOutputs = {};
  confirmations = new MediaDeleteConfirmations();
  await registerMediaLibraryRoutes(
    app,
    { isAuthenticated: async (req) => req.headers["x-test-session"] === "active" } as AuthService,
    repo,
    storage,
    new MediaResults(storage, { get: async () => undefined } as never, assets,
      { getRun: () => ({ outputs: {}, nodes: [{ outputs: workflowOutputs }] }) } as never, files), confirmations,
  );
  url = (await app.listen({ port: 0, host: "127.0.0.1" })) + "/api/v1/media-libraries";
  png = await sharp({ create: { width: 16, height: 24, channels: 3, background: "#abc" } })
    .png()
    .toBuffer();
});
afterEach(async () => {
  await app.close();
  db.close();
  await rm(root, { recursive: true, force: true });
});

function request(path: string, method = "GET", body?: object) {
  return fetch(url + path, {
    method,
    headers: { "x-test-session": "active", ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
}
function upload(lib: string, name: string, data = png) {
  const body = new FormData();
  body.append("file", new Blob([new Uint8Array(data)]), name);
  return fetch(url + "/" + lib + "/files", { method: "POST", headers: { "x-test-session": "active" }, body });
}

it("按运行输出标识归档指定文件，并发冲突保留独立原件", async () => {
  const lib = repo.create("归档");
  const one = await files.upload(Readable.from(png), "一.png", "image/png");
  const second = await sharp(png).resize(7, 9).png().toBuffer();
  const two = await files.upload(Readable.from(second), "二.png", "image/png");
  workflowOutputs = { images: [one, two] };
  const path = "/" + lib.id + "/files/from-result";
  const body = { source: "workflow", taskId: "运行", assetId: two.assetId, name: "所选.png" };
  const missing = await request(path, "POST", { ...body, assetId: randomUUID() });
  expect(missing.status).toBe(404);
  expect(await missing.json()).toMatchObject({ error: { code: "NOT_FOUND" } });
  const replies = await Promise.all([request(path, "POST", body), request(path, "POST", body)]);
  expect(replies.map(r => r.status).sort()).toEqual([201, 409]);
  const saved = await replies.find(r => r.ok)!.json();
  expect(await replies.find(r => !r.ok)!.json()).toMatchObject({ error: { code: "MEDIA_NAME_CONFLICT" } });
  await files.remove(two.assetId);
  expect(Buffer.from(await (await request("/" + lib.id + "/files/" + saved.id + "/content")).arrayBuffer())).toEqual(second);
});

it("工具按当前库授权返回 JPEG 和执行引用，上传权限独立", async () => {
  const a = repo.create("可读"), b = repo.create("可写");
  const file = await storage.save(a.id, "原图.png", png);
  const profile = { allowedTools: ["media_library"], mediaLibraryGrants: [
    { libraryId: a.id, read: true, upload: false, publicTransfer: false },
    { libraryId: b.id, read: false, upload: true, publicTransfer: false },
  ] } as AgentProfile;
  const access = new MediaAccess(repo, storage, async id => id === "A" ? profile : undefined,
    { readFile: async () => ({ content: png, name: "上传.png" }) } as never);
  const tool = createMediaTool("A", access);
  const params = { action: "view" as const, libraryId: a.id, fileId: file.id, category: null, path: null, name: null };
  expect(tool.parameters.type).toBe("object");
  for (const key of ["anyOf", "oneOf", "allOf"]) expect(tool.parameters).not.toHaveProperty(key);
  expect(Check(tool.parameters, {})).toBe(false);
  expect(Check(tool.parameters, params)).toBe(true);
  await expect(tool.execute("call", { ...params, path: "非法" }, undefined, undefined, {} as never)).rejects.toThrow("无关");
  const viewed = await tool.execute("call", params, undefined, undefined, {} as never);
  const preview = viewed.content[0];
  expect(preview.type).toBe("image");
  if (preview.type === "image") expect((await sharp(Buffer.from(preview.data, "base64")).metadata()).format).toBe("jpeg");
  const uploaded = await access.upload("A", b.id, "上传.png", null);
  await expect(access.read(mediaReference(b.id, uploaded.id), "image", "image", "A")).rejects.toThrow("读取");
  await expect(access.files("A", b.id, null)).rejects.toThrow("读取");
  await expect(access.libraries("B")).rejects.toThrow("工具权限");
  const ref = mediaReference(a.id, file.id);
  repo.renameFile(a.id, file.id, "改名.png", 1);
  expect((await access.read(ref, "image", "image", "A")).content).toEqual(png);
  await expect(access.read(ref, "image", "image", "A", true)).rejects.toThrow("公网传输");
  profile.allowedTools = [];
  await expect(access.read(ref, "image", "image", "A")).rejects.toThrow("工具权限");
});

it("DAG 按目标路径验证公网授权并固定执行副本", async () => {
  const lib = repo.create("运行"), file = await storage.save(lib.id, "图.png", png);
  const ref = mediaReference(lib.id, file.id);
  const grant = { libraryId: lib.id, read: true, upload: false, publicTransfer: false };
  const access = new MediaAccess(repo, storage, async () => ({ allowedTools: ["media_library"], mediaLibraryGrants: [grant] }) as AgentProfile, {} as never);
  const inputs = new WorkflowMediaInputs(access, files, { get: async () => ({ protocol: "grok" }) } as never, "https://media.example");
  const draft = emptyWorkflow();
  const start = draft.nodes.find(n => n.kind === "input")!;
  start.outputs.push({ name: "image", type: "image" });
  const node = newWorkflowNode("aigc", "grok");
  node.inputs.image = { kind: "reference", nodeId: start.id, field: "image" };
  draft.nodes.push(node);
  const definition = { ...draft, id: "dag", revision: 1, createdAt: "", updatedAt: "" };
  const checks: (() => Promise<unknown>)[] = [];
  await expect(inputs.copyForRun(definition, {}, { image: ref }, "A", false, [], checks)).rejects.toThrow("公网传输");
  await expect(inputs.copyForRun(definition, {}, { image: ref }, undefined, false, [], checks)).rejects.toThrow("确认");
  grant.publicTransfer = true;
  const result = await inputs.copyForRun(definition, {}, { image: ref }, "A", false, [], checks);
  await checks[0]();
  repo.removeFile(lib.id, file.id, 1);
  await storage.discard(file.id);
  expect((await files.buffer(result.image, "A", undefined, true)).content).toEqual(png);
});

it("手动批次一次确认公网传输，独立运行共用固定文件、字段默认值及数组顺序", async () => {
  const lib = repo.create("批量");
  const file = await storage.save(lib.id, "输入.png", png);
  const access = new MediaAccess(repo, storage, async () => undefined, {} as never);
  const media = new WorkflowMediaInputs(access, files, { get: async () => ({ protocol: "grok" }) } as never, "https://media.example");
  const service = new WorkflowService(new WorkflowRepository(join(root, "batch"), db), { execute: async () => ({ files: [] }) }, undefined, undefined, media);
  await service.initialize();
  try {
    const draft = emptyWorkflow();
    const input = draft.nodes[0];
    input.outputs[0].defaultValue = "默认文本";
    input.outputs.push({ name: "image", type: "image" }, { name: "labels", type: "string", multiple: true });
    const target = newWorkflowNode("aigc", "public");
    target.config.interfaceId = "grok";
    target.inputs.image = { kind: "reference", nodeId: input.id, field: "image" };
    draft.nodes.push(target);
    draft.edges.push({ id: "to-public", source: input.id, target: target.id }, { id: "after-public", source: target.id, target: "output" });
    const { id } = await service.save(draft);
    const request = { count: 3, requestKey: "media-batch", inputs: { image: mediaReference(lib.id, file.id), labels: ["乙", "甲"] } };
    await expect(service.startManualBatch(id, request)).rejects.toMatchObject({ code: "VALIDATION_FAILED", details: { requiresPublicTransfer: true } });
    expect(service.listRuns()).toHaveLength(0);
    const read = vi.spyOn(access, "read");
    const receipt = await service.startManualBatch(id, { ...request, confirmPublicTransfer: true });
    expect(read).toHaveBeenCalledTimes(1);
    const snapshot = service.getRun(receipt.runIds[0]).inputs;
    expect(snapshot).toMatchObject({ prompt: "默认文本", labels: ["乙", "甲"] });
    expect((await files.buffer(snapshot.image, undefined, undefined, true)).content).toEqual(png);
    for (const runId of receipt.runIds) {
      const run = await service.wait(runId);
      expect(run.inputs).toEqual(snapshot);
      expect(run.status).toBe("succeeded");
    }
  } finally {
    await service.close();
  }
});

it("Grok 校验和显式确认先于公共副本创建，提交失败回收副本", async () => {
  const lib = repo.create("公网"), file = await storage.save(lib.id, "原图.png", png);
  const input = { interfaceId: "grok", inputs: { image: mediaReference(lib.id, file.id), prompt: "编辑" } };
  const { AigcPublicFileService } = await import("../aigc/aigc-public-file-service");
  const publicFiles = new AigcPublicFileService(join(root, "public"));
  const deps = { mediaAccess: new MediaAccess(repo, storage, async () => undefined, {} as never),
    assets, publicFiles, publicOrigin: "https://media.example", workflows: {} as never,
    interfaces: { get: async () => ({ protocol: "grok", enabled: true, capability: "image-edit", config: { model: "image" } }) } as never,
    tasks: { createRun: async () => { throw new Error("队列关闭"); } } as never };
  await expect(submitMediaInputs(input, deps)).rejects.toThrow("确认");
  await expect(submitMediaInputs({ ...input, confirmPublicTransfer: true }, { ...deps, publicOrigin: undefined })).rejects.toThrow("Origin");
  await expect(submitMediaInputs({ ...input, confirmPublicTransfer: true, inputs: { ...input.inputs, size: "bad" } }, deps)).rejects.toThrow("WIDTHxHEIGHT");
  expect(await publicFiles.list()).toHaveLength(0);
  await expect(submitMediaInputs({ ...input, confirmPublicTransfer: true }, deps)).rejects.toThrow("队列关闭");
  expect(await publicFiles.list()).toHaveLength(0);
});

it("并发同库重名只提交一次，预检、筛选、读取、改名共用稳定标识", async () => {
  const a = await (await request("", "POST", { name: "甲" })).json();
  const b = await (await request("", "POST", { name: "乙" })).json();
  const replies = await Promise.all([upload(a.id, "图A.png"), upload(a.id, " 图a.PNG ")]);
  expect(replies.map((r) => r.status).sort()).toEqual([201, 409]);
  const conflict = replies.find((r) => r.status === 409)!;
  expect((await conflict.json()).error).toMatchObject({
    code: "MEDIA_NAME_CONFLICT",
    requestId: conflict.headers.get("x-request-id"),
  });
  const item = await replies.find((r) => r.status === 201)!.json();
  const filePath = "/" + a.id + "/files/" + item.id;
  expect((await upload(b.id, item.name)).status).toBe(201);
  expect(await (await request("/" + a.id + "/name-check?name=" + encodeURIComponent(" 图a.png "))).json()).toEqual(
    { available: false },
  );
  expect(await (await request("/" + a.id + "/files?category=video")).json()).toEqual({ files: [] });
  expect(await (await request(filePath, "PATCH", { name: "新名.png", revision: 1 })).json()).toMatchObject({
    id: item.id,
    name: "新名.png",
    revision: 2,
  });
  expect((await request(filePath, "PATCH", { name: "错误.jpg", revision: 2 })).status).toBe(400);
  const thumb = await request(filePath + "/thumbnail");
  expect((await sharp(Buffer.from(await thumb.arrayBuffer())).metadata()).format).toBe("jpeg");
  const range = await fetch(url + filePath + "/content", {
    headers: { "x-test-session": "active", range: "bytes=2-5" },
  });
  expect(range.status).toBe(206);
  expect(Buffer.from(await range.arrayBuffer())).toEqual(png.subarray(2, 6));
  for (const path of ["", filePath + "/content", filePath + "/thumbnail"])
    expect((await fetch(url + path)).status).toBe(401);
  expect((await request("/" + b.id + "/files/" + item.id + "/content")).status).toBe(404);
});

it("删除校验名称和范围，确认后原件和封面不可读，其余库可用", async () => {
  const a = repo.create("甲");
  const b = repo.create("乙");
  const item = await (await upload(a.id, "拍摄.png")).json();
  const before = repo.library(a.id);
  expect((await request("/" + a.id, "DELETE", { ...before, name: "错" })).status).toBe(400);
  const path = "/" + a.id + "/files/" + item.id;
  expect((await request(path, "DELETE", { revision: item.revision })).status).toBe(204);
  const replacement = await (await upload(a.id, "拍摄.png")).json();
  expect((await request("/" + a.id, "DELETE", before)).status).toBe(409);
  expect((await request("/" + a.id, "DELETE", repo.library(a.id))).status).toBe(204);
  for (const suffix of ["", "/content", "/thumbnail"])
    expect((await request("/" + a.id + "/files/" + replacement.id + suffix)).status).toBe(404);
  expect(await readdir(join(root, "objects"))).toEqual([]);
  expect((await request("/" + b.id, "PATCH", { name: "空库", revision: 1 })).status).toBe(200);
  expect((await request("/" + b.id, "DELETE", repo.library(b.id))).status).toBe(204);
});

it("损坏和错误格式不会留下文件，重启清理未提交目录并保留有效原件", async () => {
  const lib = repo.create("重启");
  expect((await upload(lib.id, "bad.jpg")).status).toBe(422);
  expect((await upload(lib.id, "bad.png", Buffer.from("invalid"))).status).toBe(422);
  expect((await upload(lib.id, "bad.txt")).status).toBe(415);
  const jpeg = await sharp(png).jpeg().toBuffer();
  const item = await (await upload(lib.id, "照片.jpg", jpeg)).json();
  expect(() =>
    db.transaction(() => {
      repo.removeLibrary(lib.id, repo.library(lib.id));
      throw new Error("模拟回滚");
    }),
  ).toThrow("模拟回滚");
  db.close();
  db = openDatabase(join(root, "index.sqlite"));
  runMigrations(db);
  repo = new MediaRepository(db);
  const restarted = new MediaStorage(join(root, "objects"), repo);
  await mkdir(join(root, "objects", randomUUID()));
  await restarted.recover();
  expect(await readdir(join(root, "objects"))).toEqual([item.id]);
  expect(repo.file(lib.id, item.id).name).toBe("照片.jpg");
  expect((await restarted.resolve(item, false)).size).toBe(jpeg.length);
});

it("超限文件和不完整上传不会改变删除确认范围", async () => {
  const lib = repo.create("上传异常");
  const big = await upload(lib.id, "大图.png", Buffer.alloc(50 * 1024 * 1024 + 1));
  expect(big.status).toBe(413);
  expect((await big.json()).error).toMatchObject({
    code: "MEDIA_UPLOAD_LIMIT", requestId: big.headers.get("x-request-id"), message: expect.stringContaining("50 MiB"),
  });
  const response = await fetch(url + "/" + lib.id + "/files", {
    method: "POST",
    headers: { "x-test-session": "active", "content-type": "multipart/form-data; boundary=test-boundary" },
    body: Buffer.concat([Buffer.from('--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="partial.png"\r\nContent-Type: image/png\r\n\r\n'), png]),
  });
  expect(response.status).toBe(400);
  expect(repo.library(lib.id)).toEqual(lib);
  expect(await readdir(join(root, "objects"))).toEqual([]);
});

it("库资料原子保存、按码点计数，并保护旧编辑和删除确认", async () => {
  const lib = repo.create("旧名称");
  const other = repo.create("é");
  const item = await (await upload(lib.id, "图.png")).json();
  const before = repo.library(lib.id);
  const path = "/" + lib.id;
  const note = "<b>用途</b>\n" + "😀".repeat(490);
  expect(Array.from(note)).toHaveLength(500);
  const draft = { name: " e\u0301 ", note: " " + note + " ", revision: before.revision };
  expect((await fetch(url + path, { method: "PATCH" })).status).toBe(401);
  const saved = await (await request(path, "PATCH", draft)).json();
  expect(saved).toEqual({ ...before, name: other.name, note, revision: before.revision + 1 });
  expect(repo.library(other.id)).toEqual(other);
  expect((await (await request("")).json()).libraries).toContainEqual(saved);
  expect(Buffer.from(await (await request(path + "/files/" + item.id + "/content")).arrayBuffer())).toEqual(png);

  for (const [changes, field] of [
    [{ name: "  ", note: "新备注" }, "name"],
    [{ name: "新名称", note: note + "!" }, "note"],
    [{ name: "新名称", note: null }, "note"],
  ] as const) {
    const res = await request(path, "PATCH", { ...changes, revision: saved.revision });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({
      code: "VALIDATION_FAILED", message: expect.stringContaining(field === "name" ? "名称" : "备注"),
      details: { field }, requestId: res.headers.get("x-request-id"),
    });
  }
  expect(await (await request(path, "PATCH", { name: saved.name, revision: saved.revision })).json()).toEqual(saved);
  const cleared = await (await request(path, "PATCH", { ...saved, note: " \n " })).json();
  expect(cleared).toEqual({ ...saved, note: "", revision: saved.revision + 1 });
  for (const method of ["PATCH", "DELETE"]) {
    const res = await request(path, method, saved);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({
      code: "VERSION_CONFLICT", message: expect.stringContaining("重新确认"), requestId: res.headers.get("x-request-id"),
    });
  }
  expect(await (await request(path)).json()).toEqual(cleared);
  expect((await request(path, "DELETE", cleared)).status).toBe(204);
  expect((await request(path, "PATCH", saved)).status).toBe(404);
});

it("升级已有库后，空备注可编辑并在数据库重开后读取", () => {
  const file = join(root, "legacy.sqlite");
  const legacy = openDatabase(file);
  try {
    runMigrations(legacy, { throughVersion: 9 });
    legacy.write("INSERT INTO media_libraries(id,name,revision) VALUES (?,?,?)", ["legacy", "旧库", 7]);
    runMigrations(legacy);
    const upgraded = new MediaRepository(legacy);
    expect(upgraded.library("legacy")).toEqual({ id: "legacy", name: "旧库", revision: 7, fileCount: 0, note: "" });
    upgraded.updateLibrary("legacy", "旧库", 7, "用途");
  } finally {
    legacy.close();
  }
  const reopened = openDatabase(file);
  try {
    runMigrations(reopened);
    expect(new MediaRepository(reopened).library("legacy")).toMatchObject({ note: "用途", revision: 8 });
  } finally {
    reopened.close();
  }
});

it("批删完整校验参数，逐项区分缺失、版本冲突、清理失败与成功", async () => {
  const lib = repo.create("批删");
  const [changed, cleanup, deleted] = await Promise.all(["改.png", "清.png", "删.png"].map(name => storage.save(lib.id, name, png)));
  const path = "/" + lib.id + "/files/delete";
  const targets = [changed, cleanup, deleted].map(({ id, revision }) => ({ id, revision }));
  const bad = await request(path, "POST", { files: [...targets, targets[0]] });
  expect(bad.status).toBe(400);
  expect((await bad.json()).error).toMatchObject({ code: "VALIDATION_FAILED", requestId: bad.headers.get("x-request-id"), message: expect.stringContaining("重复") });
  expect(repo.library(lib.id).fileCount).toBe(3);
  repo.renameFile(lib.id, changed.id, "新.png", changed.revision);
  vi.spyOn(storage, "discard").mockRejectedValueOnce(new Error("测试目录不可写"));
  const missing = { id: randomUUID(), revision: 1 };
  const body = { files: [...targets, missing] };
  const response = await request(path, "POST", body);
  expect(await response.json()).toMatchObject({ results: [
    { id: changed.id, status: "failed", code: "VERSION_CONFLICT" },
    { id: cleanup.id, status: "cleanup_failed", code: "MEDIA_STORAGE_FAILED" },
    { id: deleted.id, status: "deleted" }, { id: missing.id, status: "missing" },
  ] });
  const replacement = await storage.save(lib.id, deleted.name, png);
  await request(path, "POST", body);
  expect(repo.listFiles(lib.id).map(f => f.id)).toEqual([replacement.id, changed.id]);
  for (const suffix of ["/thumbnail", "/content"])
    expect((await request("/" + lib.id + "/files/" + cleanup.id + suffix)).status).toBe(404);
  await storage.recover();
  expect(await readdir(join(root, "objects"))).not.toContain(cleanup.id);
});

it("删除工具绑定会话、确认快照和当前授权，用户决定仅可消费一次", async () => {
  const lib = repo.create("源库"), other = repo.create("其他库");
  const first = await storage.save(lib.id, "一.png", png), second = await storage.save(lib.id, "二.png", png);
  const params = { libraryId: lib.id, fileIds: [first.id, second.id] };
  const grant = { libraryId: lib.id, read: false, upload: false, publicTransfer: false, delete: true };
  const profile = { allowedTools: ["media_library_delete"], mediaLibraryGrants: [grant] } as AgentProfile;
  const access = new MediaAccess(repo, storage, async () => profile, {} as never);
  const tool = createMediaDeleteTool("agent", "session", access, confirmations);
  const invoke = (input = params) => tool.execute("call", input, undefined, undefined, {} as never);
  const path = "/confirmations/agent/session";
  expect(tool.parameters.type).toBe("object");
  for (const key of ["anyOf", "oneOf", "allOf"]) expect(tool.parameters).not.toHaveProperty(key);
  await expect(invoke({ ...params, confirm: true } as typeof params)).rejects.toThrow("标识");
  await expect(access.files("agent", lib.id, null)).rejects.toThrow("工具权限");
  await expect(invoke({ ...params, libraryId: other.id })).rejects.toThrow("授权");
  const foreign = await storage.save(other.id, first.name, png);
  await expect(invoke({ ...params, fileIds: [first.id, foreign.id] })).rejects.toThrow("指定库");
  profile.allowedTools = ["media_library"];
  await expect(invoke()).rejects.toThrow("授权");
  profile.allowedTools = ["media_library_delete"];
  for (const action of ["取消", "撤权", "确认"]) {
    const outcome = invoke().then(value => value.details, error => String(error));
    const [prompt] = (await (await request(path)).json()).confirmations;
    expect(prompt).toMatchObject({ libraryName: lib.name, files: [first, second].map(({ id, name, revision }) => ({ id, name, revision })) });
    expect(repo.library(lib.id).fileCount).toBe(2);
    const decide = path + "/" + prompt.id;
    expect((await fetch(url + decide, { method: "POST" })).status).toBe(401);
    expect((await request(decide.replace("/session/", "/other/"), "POST", { confirm: true })).status).toBe(404);
    if (action === "撤权") grant.delete = false;
    expect((await request(decide, "POST", { confirm: action !== "取消" })).status).toBe(204);
    if (action === "取消") expect(await outcome).toContain("取消");
    if (action === "撤权") expect(await outcome).toContain("授权");
    if (action === "确认") expect(await outcome).toMatchObject({ results: params.fileIds.map(id => ({ id, status: "deleted" })) });
    expect((await request(decide, "POST", { confirm: true })).status).toBe(404);
    grant.delete = true;
  }
  expect(repo.library(lib.id).fileCount).toBe(0);
  expect(repo.library(other.id).fileCount).toBe(1);
});

it("停止或超时使会话确认失效", async () => {
  const prompt = { libraryId: randomUUID(), libraryName: "确认", files: [] };
  const controller = new AbortController();
  const waiting = confirmations.wait("agent", "session", prompt, controller.signal);
  controller.abort();
  await expect(waiting).rejects.toThrow("停止");
  vi.useFakeTimers();
  try {
    const expired = expect(confirmations.wait("agent", "session", prompt)).rejects.toThrow("过期");
    await vi.advanceTimersByTimeAsync(300_001);
    await expired;
    expect(confirmations.list("agent", "session")).toEqual([]);
  } finally {
    vi.useRealTimers();
  }
});
