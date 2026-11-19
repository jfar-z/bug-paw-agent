// @vitest-environment node
import multipart from "@fastify/multipart";
import Fastify from "fastify";
import { mkdtemp, mkdir, readdir, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it } from "vitest";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { registerApiV1Namespace } from "../http/api-versioning";
import { registerApiErrorHandler } from "../http/error-handler";
import { MediaRepository } from "../media-library/media-repository";
import { MediaStorage } from "../media-library/media-storage";
import { registerMediaLibraryRoutes } from "./media-libraries";
import type { AuthService } from "./auth";

let root: string;
let db: ReturnType<typeof openDatabase>;
let app: ReturnType<typeof Fastify>;
let repo: MediaRepository;
let storage: MediaStorage;
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
  app = Fastify();
  registerApiV1Namespace(app);
  registerApiErrorHandler(app);
  await app.register(multipart);
  await registerMediaLibraryRoutes(
    app,
    { isAuthenticated: async (req) => req.headers["x-test-session"] === "active" } as AuthService,
    repo,
    storage,
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
