import { describe, expect, it, vi } from "vitest";
import { GrokAigcAdapter } from "./grok-adapter";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

/** 校验 Grok 图片编辑请求体与单图兼容性。 */
describe("GrokAigcAdapter 图片编辑", () => {
  it("保留提交入参与轮询 HTTP 200 业务失败正文", async () => {
    const request = vi.fn()
      .mockResolvedValueOnce(Response.json({ task_id: "task-1" }))
      .mockResolvedValueOnce(Response.json({ status: "failed", error: { code: "content_policy", message: "内容被拒绝" } }));
    const onDiagnostics = vi.fn<NonNullable<AigcExecutionInput["onDiagnostics"]>>(async () => {});
    await expect(new GrokAigcAdapter(request).execute({ ...execution("https://example.test/image.png"), onDiagnostics })).rejects.toThrow("执行失败");
    expect(onDiagnostics.mock.calls[0]?.[0]?.request?.body).toMatchObject({ model: "grok-imagine-image-2.0", image: { url: "https://example.test/image.png" } });
    expect(onDiagnostics.mock.calls.at(-1)?.[0]).toMatchObject({ response: { endpoint: "image/tasks/task-1", status: 200, body: expect.stringContaining("content_policy") } });
  });

  it("多张参考图使用有序 images 列表", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 }));
    const adapter = new GrokAigcAdapter(request as unknown as typeof fetch);
    const input = execution(["https://example.test/first.png", "https://example.test/second.png"]);

    await adapter.execute(input);

    const [url, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.example.test/v1/images/edits");
    expect(JSON.parse(String(init.body))).toMatchObject({ images: [
      { url: "https://example.test/first.png", type: "image_url" },
      { url: "https://example.test/second.png", type: "image_url" },
    ] });
    expect(JSON.parse(String(init.body))).not.toHaveProperty("image");
  });

  it("单张参考图继续使用 image 字段", async () => {
    const request = vi.fn(async () => new Response(JSON.stringify({ data: [{ b64_json: "aW1hZ2U=" }] }), { status: 200 }));
    await new GrokAigcAdapter(request as unknown as typeof fetch).execute(execution("https://example.test/first.png"));
    const [, init] = request.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ image: { url: "https://example.test/first.png" } });
  });
});

/** 构造只依赖响应内 base64 产物的最小执行上下文。 */
function execution(image: string | string[]): AigcExecutionInput {
  return {
    item: { id: "grok-edit", name: "图片编辑", description: "", protocol: "grok", capability: "image-edit",
      channelId: "grok", enabled: true, toolPublishEnabled: true, config: { model: "grok-imagine-image-2.0" },
      createdAt: "2026-10-03T00:00:00.000Z", updatedAt: "2026-10-03T00:00:00.000Z" },
    channel: { id: "grok", name: "Grok", type: "grok", baseUrl: "https://api.example.test/v1", enabled: true, timeoutMs: 30_000 },
    inputs: { prompt: "组合图片", image }, assets: {} as never, signal: new AbortController().signal,
  };
}
