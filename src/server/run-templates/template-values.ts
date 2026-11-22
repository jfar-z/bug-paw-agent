import { DomainError } from "../core/errors";
import { checkValueSize } from "../workflows/workflow-validation";

/** 对可自由输入的对象和文本也检查凭据与本机路径，不把敏感原值放入错误消息。 */
export function checkTemplateValues(inputs: Record<string, unknown>) {
  checkValueSize(inputs);
  const secretKey = /^(?:authorization|password|passwd|cookie|set-cookie|secret|client[-_]?secret|(?:access|refresh|id)[-_]?token|token|api[-_]?key|private[-_]?key)$/i;
  function visit(field: string, key: string, value: unknown) {
    const reject = () => { throw new DomainError("VALIDATION_FAILED", "参数 " + field + " 包含认证信息、带凭据的链接或本机路径", { field }); };
    if (secretKey.test(key)) reject();
    if (typeof value === "string") {
      if (/^(?:\/(?!\/)|file:|[a-z]:[\\/]|\\\\)/i.test(value.trim()) || /\bBearer\s+\S+|-----BEGIN [\w ]*PRIVATE KEY-----/i.test(value)) reject();
      for (const match of value.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
        if (!URL.canParse(match[0])) continue;
        const url = new URL(match[0]);
        if (url.username || url.password || [...url.searchParams.keys()].some(k => secretKey.test(k) || /signature|credential|^sig$|^key$|^auth$/i.test(k))) reject();
      }
    } else if (value && typeof value === "object") {
      for (const [child, entry] of Object.entries(value)) visit(field, child, entry);
    }
  }
  for (const [field, value] of Object.entries(inputs)) visit(field, field, value);
}
