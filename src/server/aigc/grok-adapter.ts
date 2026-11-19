import { recordAigcRequest, readAigcResponse } from "./aigc-diagnostics";
import type { AigcChannelConfig, AigcGrokInterfaceConfig } from "../../shared/aigc-contracts";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";

type GrokOperation = "image.generate" | "image.edit" | "video.generate" | "video.edit" | "video.extend";
type GrokMediaKind = "image" | "video";

interface GrokOutputReference {
  mediaKind: GrokMediaKind;
  url?: string;
  b64Data?: string;
}

const PROMPT_MAX_LENGTH = 20_000;
const DEFAULT_POLL_INTERVAL_MS = 2_000;
const DEFAULT_TASK_TIMEOUT_MS = 600_000;
const SIZE_PATTERN = /^\d{2,5}x\d{2,5}$/u;

/** 通过 xAI Grok 标准接口执行图片与视频生成、编辑和续写。 */
export class GrokAigcAdapter implements AigcProtocolAdapter {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(private readonly request: typeof fetch = fetch) {}

  /** 按接口能力构造协议请求，并在需要时等待异步任务完成。 */
  async execute(input: AigcExecutionInput): Promise<AigcExecutionResult> {
    const config = input.item.config as AigcGrokInterfaceConfig;
    const operation = operationFor(input.item.capability);
    const payload = buildPayload(operation, config, input.inputs);
    const mediaKind = operation.startsWith("video.") ? "video" : "image";
    const result = await this.submitAndWait(input, operation, payload, mediaKind);
    const maxOutputs = mediaKind === "image" ? readCount(payload.n) : 1;
    const outputs = extractOutputs(result, mediaKind, maxOutputs);
    return { assets: await this.materializeOutputs(input, outputs, mediaKind) };
  }

  /** 提交请求，若上游返回任务标识则轮询至终态。 */
  private async submitAndWait(
    input: AigcExecutionInput,
    operation: GrokOperation,
    payload: Record<string, unknown>,
    mediaKind: GrokMediaKind,
  ): Promise<Record<string, unknown>> {
    const result = await this.requestJson(input, input.channel, "POST", endpointFor(operation), payload);
    if (hasMediaOutput(result)) return result;
    const taskId = readTaskId(result, mediaKind);
    return this.waitForTask(input, input.channel, mediaKind, taskId);
  }

  /** 按固定间隔轮询图片或视频任务状态。 */
  private async waitForTask(
    input: AigcExecutionInput,
    channel: AigcChannelConfig,
    mediaKind: GrokMediaKind,
    taskId: string,
  ): Promise<Record<string, unknown>> {
    const deadline = Date.now() + DEFAULT_TASK_TIMEOUT_MS;
    const path = mediaKind === "video"
      ? `videos/${encodeURIComponent(taskId)}`
      : `image/tasks/${encodeURIComponent(taskId)}`;
    while (true) {
      if (input.signal.aborted) throw new Error("Grok 任务已取消");
      const result = await this.requestJson(input, channel, "GET", path);
      const status = String(result.status ?? "").toLowerCase();
      if (["succeeded", "success", "completed", "done"].includes(status)) return result;
      if (status === "failed") throw new Error("Grok 媒体任务执行失败");
      if (["cancelled", "canceled"].includes(status)) throw new Error("Grok 媒体任务已取消");
      if (!["queued", "pending", "processing", "running", "in_progress", "submitted"].includes(status)) {
        throw new Error("Grok 媒体任务返回了无效状态");
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error("等待 Grok 媒体任务完成超时");
      await sleep(Math.min(DEFAULT_POLL_INTERVAL_MS, remaining), input.signal);
    }
  }

  /** 发送有界 JSON 请求并解析上游响应。 */
  private async requestJson(
    input: AigcExecutionInput,
    channel: AigcChannelConfig,
    method: "GET" | "POST",
    path: string,
    payload?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    if (payload) await recordAigcRequest(input, path, payload);
    const response = await this.request(`${channel.baseUrl}/${path}`, {
      method,
      signal: requestSignal(input.signal, channel.timeoutMs ?? 30_000),
      headers: jsonHeaders(input.apiKey),
      body: payload === undefined ? undefined : JSON.stringify(payload),
    });
    return readAigcResponse(input, response, path);
  }

  /** 将解析出的媒体引用下载或解码为任务产物。 */
  private async materializeOutputs(
    input: AigcExecutionInput,
    outputs: GrokOutputReference[],
    mediaKind: GrokMediaKind,
  ): Promise<AigcExecutionResult["assets"]> {
    const assets: AigcExecutionResult["assets"] = [];
    for (const [index, output] of outputs.entries()) {
      if (output.b64Data !== undefined) {
        assets.push({
          name: outputName(input, index, mediaKind),
          mediaType: "image/png",
          content: Buffer.from(output.b64Data, "base64"),
        });
        continue;
      }
      if (!output.url) continue;
      const downloaded = await download(this.request, resolveDownloadUrl(input.channel, output.url), input);
      assets.push({
        name: outputName(input, index, mediaKind),
        mediaType: mediaKind === "video" ? "video/mp4" : "image/png",
        content: downloaded,
      });
    }
    if (!assets.length) throw new Error("Grok 响应缺少可用产物");
    return assets;
  }
}

/** 将能力映射为 Grok 协议操作。 */
function operationFor(capability: AigcExecutionInput["item"]["capability"]): GrokOperation {
  switch (capability) {
    case "text-to-image":
      return "image.generate";
    case "image-edit":
      return "image.edit";
    case "text-to-video":
    case "image-to-video":
      return "video.generate";
    case "video-edit":
      return "video.edit";
    case "video-extend":
      return "video.extend";
  }
}

/** 构造与参考工具包一致的 URL 型 JSON 请求体。 */
function buildPayload(
  operation: GrokOperation,
  config: AigcGrokInterfaceConfig,
  inputs: Record<string, unknown>,
): Record<string, unknown> {
  const prompt = operation === "video.extend"
    ? readOptionalPrompt(inputs.prompt)
    : readRequiredPrompt(inputs.prompt);
  const payload: Record<string, unknown> = { model: readModel(config.model) };
  if (prompt !== undefined) payload.prompt = prompt;
  if (operation === "image.generate") payload.n = readCount(inputs.count);
  if (["image.generate", "image.edit", "video.generate"].includes(operation)) {
    const size = readSize(inputs.size ?? config.size);
    if (size) payload.size = size;
  }
  if (operation === "image.edit" && Array.isArray(inputs.image)) {
    if (inputs.image.length < 1 || inputs.image.length > 5) throw new TypeError("Grok 图片编辑支持 1 到 5 张参考图");
    payload.images = inputs.image.map((value) => ({ url: readInputUrl(value, "图片"), type: "image_url" }));
  } else if (operation === "image.edit" || (operation === "video.generate" && inputs.image !== undefined)) {
    payload.image = { url: readInputUrl(inputs.image, "图片") };
  }
  if (operation === "video.edit" || operation === "video.extend") {
    payload.video = { url: readInputUrl(inputs.video, "视频") };
  }
  if (operation.startsWith("video.")) {
    const duration = readDuration(inputs.duration ?? config.duration);
    if (duration !== undefined) payload.duration = duration;
  }
  return payload;
}

/** 在生成可公开副本之前复用适配器的完整请求校验。 */
export function validateGrokInputs(capability: AigcExecutionInput["item"]["capability"], config: AigcGrokInterfaceConfig, inputs: Record<string, unknown>) {
  buildPayload(operationFor(capability), config, inputs);
}

/** 返回协议端点相对路径。 */
function endpointFor(operation: GrokOperation): string {
  switch (operation) {
    case "image.generate":
      return "images/generations";
    case "image.edit":
      return "images/edits";
    case "video.generate":
      return "videos/generations";
    case "video.edit":
      return "videos/edits";
    case "video.extend":
      return "videos/extensions";
  }
}

/** 构造 JSON 请求认证头。 */
function jsonHeaders(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  };
}

/** 组合用户取消信号和渠道请求超时。 */
function requestSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(Math.max(1_000, timeoutMs))]);
}

/** 判断上游响应是否已经直接包含媒体产物。 */
function hasMediaOutput(payload: Record<string, unknown>): boolean {
  const data = payload.data;
  if (Array.isArray(data) && data.some((item) => isRecord(item) && (hasString(item.url) || hasString(item.b64_json)))) {
    return true;
  }
  const video = payload.video;
  if (isRecord(video) && hasString(video.url)) return true;
  const rawOutput = payload.output;
  const outputItems = Array.isArray(rawOutput) ? rawOutput : [rawOutput];
  return outputItems.some((item) => isRecord(item) && (hasString(item.url) || hasString(item.b64_json)));
}

/** 从受支持的响应形状提取媒体引用。 */
function extractOutputs(payload: Record<string, unknown>, mediaKind: GrokMediaKind, maxOutputs: number): GrokOutputReference[] {
  const outputs: GrokOutputReference[] = [];
  const data = payload.data;
  if (Array.isArray(data)) {
    for (const item of data) {
      if (!isRecord(item)) continue;
      if (hasString(item.url)) outputs.push({ mediaKind, url: item.url });
      else if (mediaKind === "image" && hasString(item.b64_json)) outputs.push({ mediaKind, b64Data: item.b64_json });
    }
  }
  const video = payload.video;
  if (mediaKind === "video" && isRecord(video) && hasString(video.url)) {
    outputs.push({ mediaKind: "video", url: video.url });
  }
  const rawOutput = payload.output;
  const outputItems = Array.isArray(rawOutput) ? rawOutput : [rawOutput];
  if (!outputs.length) {
    for (const item of outputItems) {
      if (!isRecord(item)) continue;
      if (hasString(item.url)) outputs.push({ mediaKind, url: item.url });
      else if (mediaKind === "image" && hasString(item.b64_json)) outputs.push({ mediaKind, b64Data: item.b64_json });
    }
  }
  if (!outputs.length) throw new Error("Grok 响应中没有可用产物");
  if (outputs.length > maxOutputs) throw new Error("Grok 返回的产物数量超过请求上限");
  return outputs;
}

/** 从任务响应读取图片或视频任务标识。 */
function readTaskId(payload: Record<string, unknown>, mediaKind: GrokMediaKind): string {
  const value = mediaKind === "video" ? payload.request_id ?? payload.id : payload.task_id;
  if (typeof value !== "string" || !value) throw new Error("Grok 响应缺少结果或任务标识");
  return value;
}

/** 校验并读取模型标识。 */
function readModel(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("Grok 模型不能为空");
  return value.trim();
}

/** 校验必填提示词。 */
function readRequiredPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("prompt 不能为空");
  const prompt = value.trim();
  if (prompt.length > PROMPT_MAX_LENGTH) throw new TypeError("prompt 超过 20000 字符限制");
  return prompt;
}

/** 读取可选提示词，空值返回 undefined。 */
function readOptionalPrompt(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  return readRequiredPrompt(value);
}

/** 读取并校验图片生成数量。 */
function readCount(value: unknown): number {
  if (value === undefined || value === null || value === "") return 1;
  if (typeof value === "boolean") throw new TypeError("count 必须是整数");
  const count = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw new TypeError("count 必须在 1 到 10 之间");
  return count;
}

/** 读取并校验可选尺寸。 */
function readSize(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !SIZE_PATTERN.test(value.trim())) throw new TypeError("size 必须使用 WIDTHxHEIGHT 格式");
  return value.trim();
}

/** 读取并校验可选视频时长。 */
function readDuration(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "boolean") throw new TypeError("duration 必须是整数");
  const duration = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(duration) || duration < 1 || duration > 300) throw new TypeError("duration 必须在 1 到 300 之间");
  return duration;
}

/** 从浏览器提交值中读取公网可访问的图片或视频 URL。 */
function readInputUrl(value: unknown, label: string): string {
  const raw = isRecord(value) && typeof value.url === "string" ? value.url : value;
  if (typeof raw !== "string" || !raw.trim()) throw new TypeError(`${label}公网地址不能为空`);
  const normalized = raw.trim();
  let parsed: URL;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new TypeError(`${label}公网地址格式无效`);
  }
  if (!["http:", "https:"].includes(parsed.protocol)
    || !parsed.hostname
    || parsed.username
    || parsed.password
    || parsed.hash) {
    throw new TypeError(`${label}公网地址必须不含凭据或片段`);
  }
  return normalized;
}

/** 解析下载地址，支持上游返回的相对路径。 */
function resolveDownloadUrl(channel: AigcChannelConfig, value: string): string {
  try {
    return new URL(value, channel.baseUrl).toString();
  } catch {
    return value;
  }
}

/** 下载单个媒体产物。 */
async function download(request: typeof fetch, url: string, input: AigcExecutionInput): Promise<Buffer> {
  const response = await request(url, { signal: input.signal });
  if (!response.ok) await readAigcResponse(input, response, "asset-download");
  return Buffer.from(await response.arrayBuffer());
}

/** 生成带序号的产物文件名。 */
function outputName(input: AigcExecutionInput, index: number, mediaKind: GrokMediaKind): string {
  const suffix = mediaKind === "video" ? "mp4" : "png";
  return `grok-${input.item.id}-${index + 1}.${suffix}`;
}

/** 等待指定时长，同时支持任务取消。 */
function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Grok 任务已取消"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** 判断值是否为字符串且非空。 */
function hasString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** 判断值是否为普通对象。 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
