import { SYSTEM_LIMITS } from "../core/limits";
import type { AigcExecutionInput } from "./aigc-protocol-adapter";

/** 不记录认证、Cookie、签名、堆栈和二进制产物字段。 */
const PRIVATE_FIELD = /authorization|cookie|password|apikey|token|secret|signature|credential|stack|b64json/iu;
const RESPONSE_LIMIT = SYSTEM_LIMITS.aigcDiagnosticResponseCharacters;

/** 保留业务文本格式与长度，同时清除已知凭据、带签名 URL 和内部路径。 */
function safeText(value: string, apiKey?: string): string {
  let text = apiKey ? value.split(apiKey).join("[已隐藏]") : value;
  text = text.replace(/https?:\/\/[^\s"<>]+/giu, (raw) => {
    try {
      const url = new URL(raw);
      url.username = "";
      url.password = "";
      for (const key of [...url.searchParams.keys()]) {
        if (PRIVATE_FIELD.test(key.replace(/[^a-z]/giu, ""))) url.searchParams.set(key, "[已隐藏]");
      }
      return url.toString();
    } catch { return "[无效 URL 已隐藏]"; }
  });
  return text
    .replace(/^\s*at .+$/gmu, "[堆栈已隐藏]")
    .replace(/\b(Bearer|Token)\s+[^\s,;"<>]+/giu, "$1 [已隐藏]")
    .replace(/\b(authorization|api[_ -]?key|cookie|password|secret|token)["']?\s*[=:]\s*["']?[^\s,;"<>]+/giu, "$1=[已隐藏]")
    .replace(/(^|[\s"'=])\/(?:[^\s/,;"<>]+\/)+[^\s,;"<>]*/gu, "$1[路径已隐藏]")
    .replace(/\b[A-Za-z]:\\(?:[^\s\\]+\\)+[^\s]*/gu, "[路径已隐藏]");
}

/** 递归脱敏，不截断完整业务入参。 */
function sanitize(value: unknown, apiKey?: string): unknown {
  if (typeof value === "string") return safeText(value, apiKey);
  if (Array.isArray(value)) return value.map((item) => sanitize(item, apiKey));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      safeText(key, apiKey),
      PRIVATE_FIELD.test(key.replace(/[^a-z]/giu, "")) ? "[已隐藏]" : sanitize(item, apiKey),
    ]));
  }
  return value;
}

/** 保存最终请求体；重复 multipart 字段保留顺序，文件只记录名称、类型和大小。 */
export async function recordAigcRequest(input: AigcExecutionInput, endpoint: string, body: Record<string, unknown> | FormData): Promise<void> {
  const snapshot = body instanceof FormData
    ? [...body.entries()].map(([name, value]) => ({ name, value: PRIVATE_FIELD.test(name.replace(/[^a-z]/giu, "")) ? "[已隐藏]" : typeof value === "string" ? value : { name: value.name, mediaType: value.type, size: value.size } }))
    : body;
  await input.onDiagnostics?.({ request: { method: "POST", endpoint, body: sanitize(snapshot, input.apiKey) }, response: undefined });
}

/** 读取一次正文并保留具体回参，支持非 JSON 错误和 HTTP 200 业务失败。 */
export async function readAigcResponse(input: AigcExecutionInput, response: Response, endpoint: string): Promise<Record<string, unknown>> {
  const raw = await response.text();
  let payload: unknown;
  try { payload = JSON.parse(raw); }
  catch { payload = undefined; }
  const safe = payload === undefined ? safeText(raw, input.apiKey) : JSON.stringify(sanitize(payload, input.apiKey), null, 2);
  await input.onDiagnostics?.({ response: {
    endpoint, status: response.status, body: safe.slice(0, RESPONSE_LIMIT), truncated: safe.length > RESPONSE_LIMIT,
  } });
  if (!response.ok) throw new Error(`${input.item.protocol} 上游服务返回 ${response.status}`);
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error(`${input.item.protocol} 上游响应格式无效`);
  return payload as Record<string, unknown>;
}
