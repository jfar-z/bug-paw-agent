import { IconButton, Button, NumberField, TextField } from "../../ui/controls";
import { Checkbox } from "../../ui/choice";
import { SearchSelect } from "../../ui/search-select";
import { ChevronDown, ChevronUp, ExternalLink, Trash2, X } from "lucide-react";
import { useMemo, useState, type FormEvent } from "react";

import type {
  SearchProviderConfig,
  SearchProviderCredentialMutation,
  SearchProviderTemplate,
  WebResearchSettingsDocument,
} from "../../../shared/web-research-contracts";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { webResearchExpected } from "../../web-research-error-policy";
import { ConfirmDialog } from "../../ui/dialog";
import { SecretInput } from "../../ui/secret-input";

/** 直连搜索服务的官方 API Key 获取入口。 */
const API_KEY_PORTALS = {
  bocha: { href: "https://open.bochaai.com", label: "博查" },
  tavily: { href: "https://app.tavily.com", label: "Tavily" },
} as const;

interface SearchProviderDialogProps {
  mode: "create" | "edit";
  document: WebResearchSettingsDocument;
  provider?: SearchProviderConfig;
  online: boolean;
  onSaved(document: WebResearchSettingsDocument): void;
  onDeleted(): void;
  onClose(): void;
}

/** 在独立事务边界内新增或编辑搜索渠道及其凭证。 */
export function SearchProviderDialog(props: SearchProviderDialogProps) {
  const { runApiTask } = useApiTask();
  const templates = useMemo(() => availableTemplates(props.document, props.mode), [props.document, props.mode]);
  const [templateId, setTemplateId] = useState(() => selectedTemplateId(props.mode, templates, props.provider));
  const [draft, setDraft] = useState<SearchProviderConfig>(() => initialProvider(props.mode, props.document, props.provider));
  const [credential, setCredential] = useState<SearchProviderCredentialMutation>({ action: "keep" });
  const [secretValue, setSecretValue] = useState("");
  const [secretVisible, setSecretVisible] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const configured = hasCredential(props.document, draft.id);
  const needsCredential = draft.type !== "searxng";
  const apiKeyPortal = draft.type === "bocha" || draft.type === "tavily"
    ? API_KEY_PORTALS[draft.type]
    : undefined;
  const finalCredentialAvailable = needsCredential
    ? credential.action === "replace" ? Boolean(credential.apiKey) : credential.action === "keep" && configured
    : true;
  const dirty = props.mode === "create"
    || JSON.stringify(draft) !== JSON.stringify(props.provider)
    || credential.action !== "keep";

  /** 切换模板时重建草稿，避免把上一供应商字段带入新渠道。 */
  const selectTemplate = (nextTemplateId: string) => {
    const template = templates.find((candidate) => candidate.id === nextTemplateId);
    if (!template) return;
    setTemplateId(nextTemplateId);
    setDraft(providerFromTemplate(template, props.document.config.searchProviders));
    setCredential({ action: "keep" });
    clearSecret();
    setError("");
  };

  const clearSecret = () => {
    setSecretValue("");
    setSecretVisible(false);
  };

  const close = () => {
    clearSecret();
    props.onClose();
  };

  const toggleSecret = async (visible: boolean) => {
    if (!visible) {
      clearSecret();
      return;
    }
    const result = await runApiTask(async () => {
      let value = secretValue;
      if (!value && props.mode === "edit" && configured) {
        value = (await api.getWebResearchProviderCredential(draft.id)).apiKey;
      }
      return value;
    }, { operation: `读取 ${draft.name} API Key`, expected: webResearchExpected(setError) });
    if (result.status === "success") {
      setSecretValue(result.data);
      setSecretVisible(true);
    }
  };

  const changeSecret = (value: string) => {
    setSecretValue(value);
    setCredential(value ? { action: "replace", apiKey: value } : { action: "keep" });
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError("");
    if (!draft.name.trim()) return setError("实例名称不能为空");
    if (draft.connectionMode === "custom" && !draft.baseUrl?.trim()) return setError("SearXNG 地址不能为空");
    if (draft.enabled && !finalCredentialAvailable) return setError("启用直连搜索服务前必须配置 API Key");
    setBusy(true);
    try {
      const result = await runApiTask(
        () => props.mode === "create"
          ? api.createWebResearchProvider({
          configRevision: props.document.revision,
          credentialRevision: props.document.credentialRevision,
          provider: { ...draft, name: draft.name.trim(), ...(draft.baseUrl ? { baseUrl: draft.baseUrl.trim() } : {}) },
          ...(secretValue ? { apiKey: secretValue } : {}),
          })
          : api.updateWebResearchProvider(draft.id, {
          configRevision: props.document.revision,
          credentialRevision: props.document.credentialRevision,
          provider: { ...draft, name: draft.name.trim(), ...(draft.baseUrl ? { baseUrl: draft.baseUrl.trim() } : {}) },
          credential,
          }),
        { operation: props.mode === "create" ? "添加搜索渠道" : "保存搜索渠道", expected: webResearchExpected(setError) },
      );
      if (result.status !== "success") return;
      clearSecret();
      props.onSaved(result.data);
    } finally {
      setBusy(false);
    }
  };

  const testConnection = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await runApiTask(
        () => api.testWebResearchProvider(draft.id),
        { operation: `测试搜索渠道 ${draft.name}`, expected: webResearchExpected(setError) },
      );
      if (result.status === "success") setMessage(result.data.message);
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError("");
    try {
      const result = await runApiTask(
        () => api.deleteWebResearchProvider(draft.id, props.document.revision, props.document.credentialRevision),
        { operation: `删除搜索渠道 ${draft.name}`, expected: webResearchExpected(setError) },
      );
      if (result.status !== "success") {
        setDeleteOpen(false);
        return;
      }
      clearSecret();
      props.onDeleted();
    } finally {
      setBusy(false);
    }
  };

  const title = props.mode === "create" ? "添加搜索渠道" : "配置搜索渠道";
  return <>
    <div className="configuration-dialog-backdrop" role="presentation">
      <form className="configuration-dialog configuration-form-card" role="dialog" aria-modal="true" aria-labelledby="search-provider-dialog-title" onSubmit={submit}>
        <header>
          <div><span>SEARCH PROVIDER</span><h2 id="search-provider-dialog-title">{title}</h2><p>渠道配置与凭证会作为一个事务保存。</p></div>
          <IconButton label="关闭配置搜索渠道" disabled={busy} onClick={close}><X size={18} aria-hidden="true" /></IconButton>
        </header>

        {props.mode === "create" ? <label><span>渠道类型</span><SearchSelect
          ariaLabel="渠道类型"
          value={templateId}
          onChange={(next) => selectTemplate(next)}
          options={templates.map((template) => ({ value: template.id, label: template.name }))}
        /></label> : null}
        <label><span>实例名称</span><TextField aria-label="实例名称" autoFocus value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} /></label>
        {draft.connectionMode === "custom" ? <label><span>SearXNG 地址</span><TextField aria-label="SearXNG 地址" placeholder="https://search.example.com" value={draft.baseUrl ?? ""} onChange={(event) => setDraft((current) => ({ ...current, baseUrl: event.target.value }))} /></label> : null}
        {needsCredential ? <label>
          <span>API Key<small>{configured && credential.action !== "remove" ? "已保存；小眼睛按需读取" : "尚未配置"}</small></span>
          <span className="api-key-field">
            <SecretInput aria-label={`${draft.name} API Key`} autoComplete="new-password" placeholder={configured ? "已配置" : "请输入 API Key"} value={secretValue} visible={secretVisible} onVisibilityChange={(visible) => void toggleSecret(visible)} onChange={(event) => changeSecret(event.target.value)} />
            {apiKeyPortal ? <small className="configuration-help"><a href={apiKeyPortal.href} target="_blank" rel="noreferrer" aria-label={`${apiKeyPortal.label} 获取 API Key（在新标签页打开）`}>获取 API Key<ExternalLink size={13} aria-hidden="true" /></a></small> : null}
          </span>
        </label> : null}
        {needsCredential && configured ? <div className="configuration-button-row"><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" onClick={() => { setCredential({ action: "remove" }); setDraft((current) => ({ ...current, enabled: false })); clearSecret(); }}>{credential.action === "remove" ? "已标记移除凭证" : "移除已保存凭证"}</Button></div> : null}
        <label className="configuration-capability-toggle"><span>立即参与路由<small>启用后会按列表顺序参与故障切换。</small></span><Checkbox aria-label="立即参与路由" checked={draft.enabled} disabled={needsCredential && !finalCredentialAvailable} onChange={(event) => setDraft((current) => ({ ...current, enabled: event.target.checked }))} /></label>

        <Button type="button" className="configuration-secondary-action" aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>{advancedOpen ? <ChevronUp size={15} aria-hidden="true" /> : <ChevronDown size={15} aria-hidden="true" />}{advancedOpen ? "收起高级设置" : "展开高级设置"}</Button>
        {advancedOpen ? <div>
          <label><span>请求超时（毫秒）</span><NumberField aria-label="请求超时（毫秒）" min={1000} max={60000} value={draft.timeoutMs} onChange={(event) => setDraft((current) => ({ ...current, timeoutMs: Number(event.target.value) }))} /></label>
          <label><span>联网出口</span><SearchSelect
            ariaLabel="联网出口"
            value={draft.egressProfileId ?? "direct"}
            onChange={(next) => setDraft((current) => ({ ...current, egressProfileId: next }))}
            options={props.document.egressProfiles.map((profile) => ({ value: profile.id, label: profile.label }))}
          /></label>
        </div> : null}

        {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
        {message ? <p className="configuration-help" role="status">{message}</p> : null}
        <footer>
          <div className="configuration-button-row">{props.mode === "edit" ? <><button type="button" className="danger-button" disabled={busy || !props.online} onClick={() => setDeleteOpen(true)}><Trash2 size={14} aria-hidden="true" />删除渠道</button><Button type="button" className="configuration-secondary-action" title={dirty ? "请先保存当前修改" : undefined} disabled={busy || !props.online || dirty} onClick={() => void testConnection()}>测试连接</Button></> : null}</div>
          <div className="configuration-button-row"><Button type="button" className="configuration-secondary-action" disabled={busy} onClick={close}>取消</Button><Button variant="primary" type="submit" className="configuration-primary-action" disabled={busy || !props.online || !draft.name.trim() || (draft.enabled && !finalCredentialAvailable)}>{busy ? "保存中…" : props.mode === "create" ? "添加渠道" : "保存渠道"}</Button></div>
        </footer>
      </form>
    </div>
    {deleteOpen ? <ConfirmDialog title="删除搜索渠道" description={`将删除“${draft.name}”及其已保存凭证。`} confirmLabel="确认删除" busy={busy} onCancel={() => setDeleteOpen(false)} onConfirm={() => void remove()} /> : null}
  </>;
}

/** 根据模式构造弹窗初始草稿。 */
function initialProvider(mode: "create" | "edit", document: WebResearchSettingsDocument, provider?: SearchProviderConfig): SearchProviderConfig {
  if (mode === "edit") {
    if (!provider) throw new TypeError("编辑搜索渠道时缺少渠道配置");
    return { ...provider };
  }
  const template = availableTemplates(document, mode)[0];
  if (!template) throw new TypeError("没有可添加的搜索渠道");
  return providerFromTemplate(template, document.config.searchProviders);
}

function providerFromTemplate(template: SearchProviderTemplate, providers: SearchProviderConfig[]): SearchProviderConfig {
  return {
    id: nextProviderId(template, providers),
    name: template.name,
    type: template.type,
    connectionMode: template.connectionMode,
    enabled: template.type === "searxng",
    timeoutMs: 10_000,
    egressProfileId: "direct",
    ...(template.connectionMode === "custom" ? { baseUrl: "" } : {}),
  };
}

/** 受管模板仅可创建一次，其他模板允许多实例。 */
function availableTemplates(document: WebResearchSettingsDocument, mode: "create" | "edit"): SearchProviderTemplate[] {
  if (mode === "edit") return document.providerTemplates;
  return document.providerTemplates.filter((template) => template.connectionMode !== "managed"
    || !document.config.searchProviders.some((provider) => provider.id === template.id));
}

function selectedTemplateId(mode: "create" | "edit", templates: SearchProviderTemplate[], provider?: SearchProviderConfig): string {
  if (mode === "edit") return templates.find((template) => template.type === provider?.type && template.connectionMode === provider.connectionMode)?.id ?? "";
  return templates[0]?.id ?? "";
}

function nextProviderId(template: SearchProviderTemplate, providers: SearchProviderConfig[]): string {
  if (template.connectionMode === "managed") return template.id;
  const base = template.type === "searxng" ? "searxng" : template.type;
  if (!providers.some((provider) => provider.id === base)) return base;
  let suffix = 2;
  while (providers.some((provider) => provider.id === `${base}-${suffix}`)) suffix += 1;
  return `${base}-${suffix}`;
}

function hasCredential(document: WebResearchSettingsDocument, providerId: string): boolean {
  return document.credentials.some((status) => status.providerId === providerId && status.configured);
}
