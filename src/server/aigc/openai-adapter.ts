import { recordAigcRequest, readAigcResponse } from "./aigc-diagnostics";
import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import type { AigcOpenAiInterfaceConfig } from "../../shared/aigc-contracts";
import { resolveOpenAiParameterDefinitions } from "../../shared/aigc-openai-parameters";
import type { AigcExecutionInput, AigcExecutionResult, AigcProtocolAdapter } from "./aigc-protocol-adapter";

/** 通过 OpenAI 标准接口执行文生图与图片编辑。 */
export class OpenAiAigcAdapter implements AigcProtocolAdapter {
  /**
   * @param request 可注入的请求函数，便于隔离外部服务测试
   */
  constructor(private readonly request: typeof fetch = fetch) {}

  /** 执行 OpenAI 图像生成接口。 */
  async execute(input: AigcExecutionInput): Promise<AigcExecutionResult> {
    const config = input.item.config as AigcOpenAiInterfaceConfig;
    const prompt = readPrompt(input.inputs.prompt);
    if (input.item.capability === "image-edit" && input.inputs.image !== undefined) {
      return this.editImage(input, config, prompt);
    }
    return this.generateImage(input, config, prompt);
  }

  /** 文生图：优先解析 base64，其次下载响应 URL。 */
  private async generateImage(
    input: AigcExecutionInput,
    config: AigcOpenAiInterfaceConfig,
    prompt: string,
  ): Promise<AigcExecutionResult> {
    const body: Record<string, unknown> = {
      model: config.model,
      prompt,
      ...readRequestParameters(config, input.inputs),
    };
    await recordAigcRequest(input, "images/generations", body);
    const response = await this.request(`${input.channel.baseUrl}/images/generations`, {
      method: "POST",
      signal: input.signal,
      headers: headers(input.apiKey),
      body: JSON.stringify(body),
    });
    const payload = await readAigcResponse(input, response, "images/generations");
    return readImageAssets(this.request, payload, input, `openai-${input.item.id}`);
  }

  /** 图片编辑：将入参图片作为 multipart 文件提交。 */
  private async editImage(
    input: AigcExecutionInput,
    config: AigcOpenAiInterfaceConfig,
    prompt: string,
  ): Promise<AigcExecutionResult> {
    const images = Array.isArray(input.inputs.image) ? input.inputs.image : [input.inputs.image];
    if (images.length < 1 || images.length > 16) throw new TypeError("图片编辑最多支持 16 张参考图");
    const form = new FormData();
    form.set("model", config.model);
    form.set("prompt", prompt);
    for (const value of images) {
      const image = readAsset(value);
      const imagePath = image.source === "public"
        ? await input.publicFiles?.resolvePath(image.assetId)
        : await input.assets.resolveInputPath(image.assetId);
      if (!imagePath) throw new Error("图片入参文件不存在");
      const imageBuffer = await readFile(imagePath);
      form.append(images.length === 1 ? "image" : "image[]",
        new Blob([imageBuffer], { type: image.mediaType || "application/octet-stream" }), image.name || basename(imagePath));
    }
    for (const [name, value] of Object.entries(readRequestParameters(config, input.inputs))) {
      form.set(name, String(value));
    }
    await recordAigcRequest(input, "images/edits", form);
    const response = await this.request(`${input.channel.baseUrl}/images/edits`, {
      method: "POST",
      signal: input.signal,
      headers: authHeaders(input.apiKey),
      body: form,
    });
    const payload = await readAigcResponse(input, response, "images/edits");
    return readImageAssets(this.request, payload, input, `openai-edit-${input.item.id}`);
  }
}

/** 仅转发接口已声明的标量参数，并使用单次运行值覆盖默认值。 */
function readRequestParameters(config: AigcOpenAiInterfaceConfig, inputs: Record<string, unknown>): Record<string, string | number | boolean> {
  const result: Record<string, string | number | boolean> = {};
  for (const parameter of resolveOpenAiParameterDefinitions(config)) {
    const inputValue = inputs[parameter.name];
    const value = inputValue === undefined || inputValue === "" ? parameter.defaultValue : inputValue;
    if (value === undefined) continue;
    if (!matchesParameterType(value, parameter.type)) throw new TypeError(`参数 ${parameter.name} 类型无效`);
    if (parameter.enumValues?.length && !parameter.enumValues.some((candidate) => Object.is(candidate, value))) {
      throw new TypeError(`参数 ${parameter.name} 不在枚举范围内`);
    }
    result[parameter.name] = value;
  }
  return result;
}

/** 判断运行值是否符合接口参数定义。 */
function matchesParameterType(value: unknown, type: "string" | "integer" | "number" | "boolean"): value is string | number | boolean {
  if (type === "string") return typeof value === "string";
  if (type === "boolean") return typeof value === "boolean";
  if (type === "integer") return typeof value === "number" && Number.isInteger(value);
  return typeof value === "number" && Number.isFinite(value);
}

/** 构造 JSON 请求认证头。 */
function headers(apiKey?: string): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...authHeaders(apiKey),
  };
}

/** 构造不干扰 multipart 自动边界的认证头。 */
function authHeaders(apiKey?: string): Record<string, string> {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
}

/** 按上游顺序解析全部图片；任一条目无效时失败，避免静默丢失产物。 */
async function readImageAssets(
  request: typeof fetch,
  payload: Record<string, unknown>,
  input: AigcExecutionInput,
  namePrefix: string,
): Promise<AigcExecutionResult> {
  if (!Array.isArray(payload.data) || payload.data.length === 0) {
    throw new Error("OpenAI 图像响应缺少非空 data 数组");
  }
  const assets: AigcExecutionResult["assets"] = [];
  for (const [index, data] of payload.data.entries()) {
    if (!isRecord(data)) throw new Error(`OpenAI 图像响应第 ${index + 1} 项格式无效`);
    let content: Buffer;
    if (typeof data.b64_json === "string" && data.b64_json) {
      content = Buffer.from(data.b64_json, "base64");
    } else if (typeof data.url === "string" && data.url) {
      content = await download(request, data.url, input);
    } else {
      throw new Error(`OpenAI 图像响应第 ${index + 1} 项缺少可用产物`);
    }
    // 单图保留原文件名，多图用返回序号避免下载时同名覆盖。
    const suffix = payload.data.length === 1 ? "" : `-${index + 1}`;
    assets.push({ name: `${namePrefix}${suffix}.png`, mediaType: "image/png", content });
  }
  return { assets };
}

/** 下载响应 URL，限制为图片产物字节。 */
async function download(request: typeof fetch, url: string, input: AigcExecutionInput): Promise<Buffer> {
  const response = await request(url, { signal: input.signal });
  if (!response.ok) await readAigcResponse(input, response, "asset-download");
  return Buffer.from(await response.arrayBuffer());
}

function readPrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new TypeError("prompt 不能为空");
  return value.trim();
}

function readAsset(value: unknown): { assetId: string; name?: string; mediaType?: string; source?: "public" } {
  if (!isRecord(value) || typeof value.assetId !== "string" || !value.assetId) throw new TypeError("缺少图片或视频入参");
  return {
    assetId: value.assetId,
    ...(typeof value.name === "string" ? { name: value.name } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    ...(value.source === "public" ? { source: value.source } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
