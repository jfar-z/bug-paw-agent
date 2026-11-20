import { Button } from "../../ui/controls";
import { SearchSelect } from "../../ui/search-select";
import { Plus } from "lucide-react";
import { useId, useState, type CSSProperties } from "react";
import type { ModelConfigDocument, ProviderTemplate } from "../../../shared/configuration-contracts";
import { ConfigurationEditorDialog } from "./configuration-editor-dialog";
import { useUnsavedChanges } from "../../ui/unsaved-changes";
import { useErrorToast } from "../../error-toast-provider";
import { toUnexpectedErrorNotice } from "../../api-error-policy";
import { api, type ApiClientError } from "../../api";
import { useApiTask, type ApiTaskPolicy } from "../../api-task-provider";

interface ProviderCreateDialogProps {
  revision: string;
  online: boolean;
  onCreated: (providerId: string, document: ModelConfigDocument) => void;
  onClose: () => void;
}

interface ProviderCreateDraft {
  id: string;
  name: string;
  template: ProviderTemplate;
  baseUrl: string;
}

const providerTemplateDefaults: Record<ProviderTemplate, { api: string; baseUrl: string; authHeader: boolean }> = {
  "openai-compatible": { api: "openai-completions", baseUrl: "https://api.example.com/v1", authHeader: true },
  ollama: { api: "openai-completions", baseUrl: "http://localhost:11434/v1", authHeader: false },
  vllm: { api: "openai-completions", baseUrl: "http://localhost:8000/v1", authHeader: false },
  "lm-studio": { api: "openai-completions", baseUrl: "http://localhost:1234/v1", authHeader: false },
  custom: { api: "openai-completions", baseUrl: "", authHeader: true },
};

/** 统一双列字段标题区高度，避免说明文字造成输入控件基线错位。 */
const providerCreateFieldHeadingStyle = {
  minHeight: "40px",
} satisfies CSSProperties;

/** 禁止不同控件高度触发 Grid 自动轨道拉伸，确保输入控件从同一基线开始。 */
const providerCreateFieldStyle = {
  alignContent: "start",
  gridTemplateColumns: "1fr",
} satisfies CSSProperties;

/** 校验 Pi Provider 标识，避免创建后再进入改名流程修正。 */
function validProviderId(value: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(value);
}

/** 仅允许模型 Provider 使用不携带内嵌凭证的 HTTP(S) 地址。 */
function validBaseUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/** 将创建 Provider 时可恢复的校验和并发错误保留在弹窗内。 */
function providerCreateExpected(reportError: (error: ApiClientError) => void): ApiTaskPolicy["expected"] {
  const show = reportError;
  return {
    VERSION_CONFLICT: show,
    PROVIDER_ID_EXISTS: show,
    PROVIDER_INVALID: show,
    MODEL_SCHEMA_INVALID: show,
    INVALID_PROVIDER_ID: show,
    INVALID_PROVIDER_REQUEST: show,
    INVALID_PROVIDER_BASE_URL: show,
  };
}

/**
 * 先创建最小 Provider，再由完整设置区单独保存 API Key 与其他配置。
 */
export function ProviderCreateDialog({ revision, online, onCreated, onClose }: ProviderCreateDialogProps) {
  const { runApiTask } = useApiTask();
  const formId = useId();
  const toast = useErrorToast();
  const [draft, setDraft] = useState<ProviderCreateDraft>({ id: "", name: "", template: "custom", baseUrl: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const providerId = draft.id.trim();
  const providerName = draft.name.trim();
  const baseUrl = draft.baseUrl.trim();
  const idValid = validProviderId(providerId);
  const baseUrlValid = validBaseUrl(baseUrl);
  const canSubmit = online && !busy && idValid && Boolean(providerName) && baseUrlValid;
  const validationError = providerId && !idValid
    ? "ID 只能使用字母、数字、点、下划线或连字符，且不能以符号开头或结尾。"
    : baseUrl && !baseUrlValid
      ? "Base URL 必须是有效的 HTTP 或 HTTPS 地址，且不能内嵌凭证。"
      : "";

  const guard = useUnsavedChanges({ dirty: Boolean(draft.id || draft.name || draft.baseUrl || draft.template !== "custom"), busy, label: "新建 Provider", save: submit, canSave: canSubmit });

  /** 根据模板生成不可见默认值，并提交不含凭证的最小 Provider。 */
  async function submit(): Promise<boolean> {
    if (!canSubmit) return false;
    const defaults = providerTemplateDefaults[draft.template];
    setBusy(true);
    setError("");
    try {
      const result = await runApiTask(
        () => api.createProvider(providerId, revision, {
          name: providerName,
          baseUrl,
          api: defaults.api,
          authHeader: defaults.authHeader,
          models: [],
        }),
        { operation: "创建 Provider", expected: providerCreateExpected((error) => { setError(error.message); toast.push(toUnexpectedErrorNotice(error, "创建 Provider")); }) },
      );
      if (result.status === "success") { onCreated(providerId, result.data); return true; }
      return false;
    } finally {
      setBusy(false);
    }
  }

  /** 切换模板时只重置模板负责提供的初始地址。 */
  function selectTemplate(template: ProviderTemplate) {
    setDraft((current) => ({ ...current, template, baseUrl: providerTemplateDefaults[template].baseUrl }));
    setError("");
  }

  return <>
    <ConfigurationEditorDialog variant="confirmation" classPrefix="provider" returnFocusSelector="[data-provider-create]" title="新建 Provider" description="先保存基础连接信息，创建后再配置 API Key、模型与兼容设置。" busy={busy} suspended={guard.pending} onClose={() => guard.request(onClose)} footer={<><Button type="button" className="configuration-secondary-action" disabled={busy} onClick={() => guard.request(onClose)}>取消</Button><Button variant="primary" type="submit" form={formId} className="configuration-primary-action" disabled={!canSubmit}><Plus size={15} />{busy ? "创建中…" : "创建 Provider"}</Button></>}>
      <form id={formId} className="configuration-form-card provider-create-dialog" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="thinking-protocol-preview">
          <label style={providerCreateFieldStyle}><span style={providerCreateFieldHeadingStyle}>Provider ID<small>创建后需要通过改名迁移引用</small></span><input aria-label="Provider ID" autoFocus value={draft.id} onChange={(event) => { setDraft((current) => ({ ...current, id: event.target.value })); setError(""); }} placeholder="例如 my-provider" /></label>
          <label style={providerCreateFieldStyle}><span style={providerCreateFieldHeadingStyle}>显示名称</span><input aria-label="显示名称" value={draft.name} onChange={(event) => { setDraft((current) => ({ ...current, name: event.target.value })); setError(""); }} placeholder="例如内部模型网关" /></label>
          <label style={providerCreateFieldStyle}><span style={providerCreateFieldHeadingStyle}>Provider 模板<small>协议和认证方式使用模板默认值</small></span><SearchSelect
            ariaLabel="Provider 模板"
            value={draft.template}
            onChange={(next) => selectTemplate(next as ProviderTemplate)}
            options={[
              { value: "custom", label: "自定义" },
              { value: "openai-compatible", label: "OpenAI Compatible" },
              { value: "ollama", label: "Ollama" },
              { value: "vllm", label: "vLLM" },
              { value: "lm-studio", label: "LM Studio" },
            ]}
          /></label>
          <label style={providerCreateFieldStyle}><span style={providerCreateFieldHeadingStyle}>Base URL</span><input aria-label="Base URL" inputMode="url" value={draft.baseUrl} onChange={(event) => { setDraft((current) => ({ ...current, baseUrl: event.target.value })); setError(""); }} placeholder="https://models.example.com/v1" /></label>
        </div>

        {validationError ? <p className="configuration-inline-error" role="alert">{validationError}</p> : null}
        {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
      </form>
    </ConfigurationEditorDialog>
    {guard.dialog}
  </>;
}
