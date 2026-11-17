import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AigcAssetService } from "./aigc-asset-service";
import { OpenAiAigcAdapter } from "./openai-adapter";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

describe("OpenAiAigcAdapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  describe.each(["generation", "edit"] as const)("%s 多图产物", (mode) => {
    it.each(["base64", "url", "mixed"] as const)("完整解析并保存 %s 响应", async (format) => {
      const root = await mkdtemp(join(tmpdir(), "openai-outputs-"));
      roots.push(root);
      const imagePath = join(root, "source.png");
      await writeFile(imagePath, "source");
      const contents = ["first-image", "second-image", "third-image"];
      const data = contents.map((content, index) => format === "base64" || (format === "mixed" && index !== 1)
        ? { b64_json: Buffer.from(content).toString("base64"), url: "https://example.test/unused" }
        : { url: `https://example.test/${index}` });
      const request = vi.fn(async (url: string | URL | Request, _init?: RequestInit) => {
        if (String(url).includes("/images/")) return Response.json({ data });
        return new Response(contents[Number(new URL(String(url)).pathname.slice(1))]);
      });
      const execution = input({ prompt: "猫", n: 3,
        ...(mode === "edit" ? { image: { assetId: "source" } } : {}),
      }, imagePath);
      const result = await new OpenAiAigcAdapter(request).execute(execution);
      expect(result.assets.map((asset) => asset.content.toString())).toEqual(contents);
      const prefix = mode === "edit" ? "openai-edit" : "openai";
      expect(result.assets.map((asset) => asset.name)).toEqual([1, 2, 3].map((index) => `${prefix}-openai-interface-${index}.png`));
      const body = request.mock.calls[0][1]?.body;
      expect(mode === "edit" ? (body as FormData).get("n") : JSON.parse(String(body)).n).toBe(mode === "edit" ? "3" : 3);
      expect(request).toHaveBeenCalledTimes(format === "base64" ? 1 : format === "url" ? 4 : 2);
      for (const [, init] of request.mock.calls.slice(1)) expect(init?.signal).toBe(execution.signal);
      // 使用真实文件存储校验每张图片的独立资产与字节，避免只断言响应数量。
      const storage = new AigcAssetService(join(root, "assets"));
      const saved = [];
      for (const asset of result.assets) saved.push(await storage.saveOutput("task", asset.content, asset.name, asset.mediaType));
      expect(new Set(saved.map((asset) => asset.id)).size).toBe(3);
      for (const [index, asset] of saved.entries()) {
        expect((await storage.readOutput("task", asset.id, 1024)).toString()).toBe(contents[index]);
      }
    });

    it.each([undefined, [], [null], [{ b64_json: "aW1hZ2U=" }, {}]])("拒绝不完整响应 %#", async (data) => {
      const root = await mkdtemp(join(tmpdir(), "openai-invalid-"));
      roots.push(root);
      const imagePath = join(root, "source.png");
      await writeFile(imagePath, "source");
      const execution = input({ prompt: "猫", ...(mode === "edit" ? { image: { assetId: "source" } } : {}) }, imagePath);
      await expect(new OpenAiAigcAdapter(async () => Response.json({ data })).execute(execution)).rejects.toThrow(/OpenAI 图像响应/);
    });

    it("后续 URL 下载失败时拒绝返回部分成功并保留诊断", async () => {
      const root = await mkdtemp(join(tmpdir(), "openai-download-"));
      roots.push(root);
      const imagePath = join(root, "source.png");
      await writeFile(imagePath, "source");
      const onDiagnostics = vi.fn<NonNullable<AigcExecutionInput["onDiagnostics"]>>(async () => {});
      const request = vi.fn(async (url: string | URL | Request) => String(url).includes("/images/")
        ? Response.json({ data: [{ b64_json: "aW1hZ2U=" }, { url: "https://example.test/image" }] })
        : new Response("download unavailable", { status: 502 }));
      const execution = { ...input({ prompt: "猫", ...(mode === "edit" ? { image: { assetId: "source" } } : {}) }, imagePath), onDiagnostics };
      await expect(new OpenAiAigcAdapter(request).execute(execution)).rejects.toThrow("502");
      expect(onDiagnostics.mock.calls.at(-1)?.[0]?.response).toMatchObject({ endpoint: "asset-download", status: 502 });
    });
  });

  it("单图仍使用原文件名", async () => {
    const result = await new OpenAiAigcAdapter(successfulRequest()).execute(input({ prompt: "猫" }));
    expect(result.assets).toEqual([{ name: "openai-openai-interface.png", mediaType: "image/png", content: Buffer.from("image") }]);
  });

  it("非 JSON 回参保留错误文本并标记截断、隐藏签名与路径", async () => {
    const onDiagnostics = vi.fn<NonNullable<AigcExecutionInput["onDiagnostics"]>>(async () => {});
    const body = 'gateway error api_key="fake-key" https://example.test/file?token=fake-token /private/service/file.log\n' + "x".repeat(70_000);
    const adapter = new OpenAiAigcAdapter(vi.fn(async () => new Response(body, { status: 502 })));
    await expect(adapter.execute({ ...input({ prompt: "猫" }), onDiagnostics })).rejects.toThrow("502");
    const response = onDiagnostics.mock.calls.at(-1)?.[0]?.response;
    expect(response?.truncated).toBe(true);
    expect(response?.body.length).toBe(65_536);
    expect(response?.body).toContain("gateway error");
    for (const secret of ["fake-key", "fake-token", "/private/service/file.log"]) expect(response?.body).not.toContain(secret);
  });

  it("网络失败仍保存完整请求而不伪造回参", async () => {
    const onDiagnostics = vi.fn<NonNullable<AigcExecutionInput["onDiagnostics"]>>(async () => {});
    const adapter = new OpenAiAigcAdapter(vi.fn(async () => { throw new Error("connection reset"); }));
    await expect(adapter.execute({ ...input({ prompt: "猫" }), onDiagnostics })).rejects.toThrow("connection reset");
    expect(onDiagnostics).toHaveBeenCalledTimes(1);
    expect(onDiagnostics.mock.calls[0]?.[0]?.response).toBeUndefined();
  });

  it.each([
    [400, JSON.stringify({ error: { code: "bad_size", message: "尺寸不支持", api_key: "fixture-credential" } })],
    [502, "upstream unavailable fixture-credential"],
    [200, "invalid json"],
  ])("保存 HTTP %s 失败回参并隐藏凭据", async (status, body) => {
    const onDiagnostics = vi.fn<NonNullable<AigcExecutionInput["onDiagnostics"]>>(async () => {});
    const execution = { ...input({ prompt: "完整提示\n" + "猫".repeat(3000) }), apiKey: "fixture-credential", onDiagnostics };
    const adapter = new OpenAiAigcAdapter(vi.fn(async () => new Response(body, { status })));
    await expect(adapter.execute(execution)).rejects.toThrow();
    expect(onDiagnostics.mock.calls[0]?.[0]).toMatchObject({ request: { body: { model: "image-model", quality: "high", prompt: execution.inputs.prompt } } });
    expect(onDiagnostics.mock.calls[1]?.[0]).toMatchObject({ response: { status, truncated: false } });
    expect(JSON.stringify(onDiagnostics.mock.calls)).not.toContain("fixture-credential");
    if (status === 400) expect(JSON.stringify(onDiagnostics.mock.calls)).toContain("bad_size");
  });

  it("图片生成与编辑接口未提供图片时调用生成端点并映射自定义参数", async () => {
    const request = successfulRequest();
    const adapter = new OpenAiAigcAdapter(request as unknown as typeof fetch);

    await adapter.execute(input({
      prompt: "一只猫",
      image_size: "1536x1024",
      ignored: "不会透传",
    }));

    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/v1/images/generations");
    expect(JSON.parse(String(init?.body))).toEqual({
      model: "image-model",
      prompt: "一只猫",
      image_size: "1536x1024",
      quality: "high",
    });
  });

  it("提供图片时调用编辑端点并以 multipart 发送自定义参数", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-image-edit-"));
    roots.push(root);
    const imagePath = join(root, "source.png");
    await writeFile(imagePath, Buffer.from("image"));
    const request = successfulRequest();
    const adapter = new OpenAiAigcAdapter(request as unknown as typeof fetch);

    const onDiagnostics = vi.fn<NonNullable<AigcExecutionInput["onDiagnostics"]>>(async () => {});
    await adapter.execute({ ...input({
      prompt: "改成水彩风",
      image: { assetId: "asset-1", name: "source.png", mediaType: "image/png" },
      image_size: "1024x1024",
      quality: "medium",
    }, imagePath), onDiagnostics });
    expect(onDiagnostics.mock.calls[0]?.[0]?.request?.body).toContainEqual({ name: "image", value: { name: "source.png", mediaType: "image/png", size: 5 } });

    const [url, init] = request.mock.calls[0];
    expect(String(url)).toBe("https://api.example.test/v1/images/edits");
    const form = init?.body as FormData;
    expect(form.get("model")).toBe("image-model");
    expect(form.get("prompt")).toBe("改成水彩风");
    expect(form.get("image_size")).toBe("1024x1024");
    expect(form.get("quality")).toBe("medium");
    expect(form.get("image")).toBeInstanceOf(File);
  });

  it("按输入顺序提交多张编辑参考图", async () => {
    const root = await mkdtemp(join(tmpdir(), "openai-multi-edit-"));
    roots.push(root);
    const first = join(root, "first.png");
    const second = join(root, "second.png");
    await writeFile(first, "first");
    await writeFile(second, "second");
    const request = successfulRequest();
    const adapter = new OpenAiAigcAdapter(request as unknown as typeof fetch);
    const execution = input({ prompt: "组合图片", image: [
      { assetId: "first", name: "first.png", mediaType: "image/png" },
      { assetId: "second", name: "second.png", mediaType: "image/png" },
    ] });
    execution.assets = { resolveInputPath: vi.fn(async (id: string) => id === "first" ? first : second) } as never;

    await adapter.execute(execution);

    const form = request.mock.calls[0][1]?.body as FormData;
    expect(form.get("image")).toBeNull();
    expect((form.getAll("image[]") as File[]).map((file) => file.name)).toEqual(["first.png", "second.png"]);
  });

function input(inputs: Record<string, unknown>, imagePath?: string, publicImagePath?: string): AigcExecutionInput {
    return {
      item: {
        id: "openai-interface",
        name: "图片生成与编辑",
        description: "",
        protocol: "openai",
        capability: "image-edit",
        channelId: "openai",
        enabled: true,
        toolPublishEnabled: false,
        config: {
          model: "image-model",
          parameters: [
            { name: "n", type: "integer", description: "数量" },
            { name: "image_size", type: "string", description: "尺寸" },
            { name: "quality", type: "string", enumValues: ["medium", "high"], defaultValue: "high", description: "质量" },
          ],
        },
        createdAt: "2026-08-25T00:00:00.000Z",
        updatedAt: "2026-08-25T00:00:00.000Z",
      },
      channel: {
        id: "openai",
        name: "OpenAI Compatible",
        type: "openai",
        baseUrl: "https://api.example.test/v1",
        enabled: true,
        timeoutMs: 30_000,
      },
      inputs,
      assets: { resolveInputPath: vi.fn(async () => imagePath) } as unknown as AigcExecutionInput["assets"],
      publicFiles: { resolvePath: vi.fn(async () => publicImagePath) } as unknown as AigcExecutionInput["publicFiles"],
      signal: new AbortController().signal,
    };
  }
});

function successfulRequest() {
  return vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  }));
}
