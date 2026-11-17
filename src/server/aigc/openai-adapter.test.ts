import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiAigcAdapter } from "./openai-adapter";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

describe("OpenAiAigcAdapter", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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
