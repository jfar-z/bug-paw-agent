import { Pencil, Plus, Save, TestTube2, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AigcChannelInput, AigcChannelSummary, AigcChannelTemplate, AigcChannelType, AigcSettingsDocument } from "../../shared/aigc-contracts";
import { api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { SecretInput } from "../ui/secret-input";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../configuration-interactions.css";
import "../aigc-channels.css";

const CACHE_KEY = "pi-agent:aigc-channels-cache";
const emptyDraft: AigcChannelInput = { name: "", type: "openai", baseUrl: "", enabled: true, timeoutMs: 30_000 };

/** 渠道列表显式进入新增或编辑，保留凭证安全、版本校验与草稿保护。 */
export function AigcChannelsPage() {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<AigcSettingsDocument>();
  const [loading, setLoading] = useState(true);
  const [editor, setEditor] = useState<"protocol" | "connection">();
  const [selected, setSelected] = useState<AigcChannelSummary>();
  const [draft, setDraft] = useState<AigcChannelInput>(emptyDraft);
  const [draftId, setDraftId] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [testResult, setTestResult] = useState("");
  const [busy, setBusy] = useState<"saving" | "testing" | "credential" | "deleting">();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [savedDraft, setSavedDraft] = useState<AigcChannelInput>(emptyDraft);
  const [revealedKey, setRevealedKey] = useState("");
  const taskLock = useRef(false);
  const dirty = editor === "connection" && (JSON.stringify(draft) !== JSON.stringify(savedDraft) || Boolean(apiKey && apiKey !== revealedKey));
  const versionAvailable = Boolean(document?.revision && document.credentialRevision);
  const writable = online && !loading && !busy && versionAvailable;
  const guard = useUnsavedChanges({ dirty, busy: Boolean(busy), label: selected ? `AIGC 渠道 · ${selected.name}` : "新增 AIGC 渠道", save, canSave: online && versionAvailable });

  useEffect(() => {
    let active = true;
    const cached = readCache();
    if (cached) setDocument(cached);
    void (async () => {
      const result = cached
        ? await runOptionalApiTask(api.getAigcChannels, { operation: "加载 AIGC 渠道", fallbackReason: "正在显示上次缓存的配置；离线时不能保存。", fallback: () => cached })
        : await runApiTask(api.getAigcChannels, { operation: "加载 AIGC 渠道" });
      if (!active) return;
      if (result.status === "success" || result.status === "fallback") {
        setDocument(result.data);
        if (result.status === "success") await cacheDocument(result.data);
        else setMessage(result.reason);
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [runApiTask, runOptionalApiTask]);

  /** 缓存仅包含服务端脱敏摘要，缓存写入失败仍走统一错误展示。 */
  async function cacheDocument(next: AigcSettingsDocument) {
    await runApiTask(async () => window.localStorage.setItem(CACHE_KEY, JSON.stringify(next)), { operation: "更新 AIGC 渠道离线摘要" });
  }

  /** 删除后的重载不得回退到旧版本；成功读取才重新允许写入。 */
  async function reload(): Promise<boolean> {
    setLoading(true);
    try {
      const result = await runApiTask(api.getAigcChannels, { operation: "重新加载 AIGC 渠道" });
      if (result.status !== "success") return false;
      setDocument(result.data);
      await cacheDocument(result.data);
      return true;
    } finally { setLoading(false); }
  }

  /** 关闭时清除明文密钥和草稿，不把它们留在隐藏表单中。 */
  function closeEditor() {
    setEditor(undefined); setDeleteOpen(false); setSelected(undefined);
    setDraft(emptyDraft); setSavedDraft(emptyDraft); setDraftId("");
    setApiKey(""); setRevealedKey(""); setApiKeyVisible(false); setTestResult("");
  }

  /** 保存响应直接提供最新对象和版本，避免重复读取列表。 */
  function select(channel: AigcChannelSummary) {
    const next = { name: channel.name, type: channel.type, baseUrl: channel.baseUrl, enabled: channel.enabled, timeoutMs: channel.timeoutMs };
    setSelected(channel); setDraft(next); setSavedDraft(next); setDraftId(channel.id);
    setApiKey(""); setRevealedKey(""); setApiKeyVisible(false); setTestResult(""); setMessage(""); setEditor("connection");
  }

  /** 每次选择协议创建独立草稿标识，协议一旦进入表单便固定。 */
  function createDraft(template: AigcChannelTemplate) {
    const next: AigcChannelInput = { name: "", type: template.type, baseUrl: template.defaultBaseUrl, enabled: true, timeoutMs: template.type === "comfyui" ? undefined : 30_000 };
    setSelected(undefined); setDraftId(crypto.randomUUID()); setDraft(next); setSavedDraft(next);
    setApiKey(""); setRevealedKey(""); setApiKeyVisible(false); setMessage(""); setTestResult(""); setEditor("connection");
  }

  /** 参数变更会使当前测试结果失效，不暗示新草稿已经通过测试。 */
  function updateDraft<K extends keyof AigcChannelInput>(key: K, value: AigcChannelInput[K]) {
    setDraft((current) => ({ ...current, [key]: value })); setTestResult("");
  }

  /** 查看已保存密钥不会制造脏草稿；有输入时只切换可见性。 */
  async function toggleApiKeyVisibility() {
    if (taskLock.current) return;
    if (apiKeyVisible) { setApiKeyVisible(false); return; }
    if (!selected?.hasApiKey || apiKey) { setApiKeyVisible(true); return; }
    if (!online) return;
    taskLock.current = true; setBusy("credential");
    try {
      const result = await runApiTask(() => api.getAigcChannelCredential(selected.id), { operation: "读取 AIGC 渠道 API Key", expected: aigcExpected(setMessage) });
      if (result.status === "success") { setApiKey(result.data.apiKey); setRevealedKey(result.data.apiKey); setApiKeyVisible(true); }
    } finally { taskLock.current = false; setBusy(undefined); }
  }

  /** 保存与草稿保护共享此方法；只有显式保存按钮决定关闭抽屉。 */
  async function save(): Promise<boolean> {
    if (!online || !document || !versionAvailable || editor !== "connection" || taskLock.current) return false;
    taskLock.current = true; setBusy("saving"); setMessage(""); setTestResult("");
    try {
      const input = { ...draft, baseUrl: draft.baseUrl.trim() };
      const result = selected
        ? await runApiTask(() => api.updateAigcChannel(selected.id, { configRevision: document.revision, credentialRevision: document.credentialRevision,
            channel: { ...input, id: selected.id }, credential: apiKey ? { action: "replace", apiKey } : selected.hasApiKey ? { action: "keep" } : { action: "remove" } }),
          { operation: "保存 AIGC 渠道", expected: aigcExpected(setMessage) })
        : await runApiTask(() => api.createAigcChannel({ configRevision: document.revision, credentialRevision: document.credentialRevision,
            channel: { ...input, id: draftId }, ...(apiKey ? { apiKey } : {}) }), { operation: "创建 AIGC 渠道", expected: aigcExpected(setMessage) });
      if (result.status !== "success") return false;
      const next = result.data;
      const current = next.channels.find((channel) => channel.id === (selected?.id ?? draftId));
      setDocument(next);
      if (!current) {
        // 返回文档必须包含已保存对象，否则不能把异常响应当作成功关闭草稿。
        await runApiTask(async () => { throw new Error("保存 AIGC 渠道的响应缺少已保存对象，请重新加载渠道确认结果"); }, { operation: "读取已保存 AIGC 渠道" });
        return false;
      }
      select(current);
      await cacheDocument(next);
      setMessage(selected ? "渠道修改已保存" : "渠道已创建");
      return true;
    } finally { taskLock.current = false; setBusy(undefined); }
  }

  /** 删除成功立即移除对象并清空版本，重读失败时不重复删除或继续用旧版本写入。 */
  async function remove() {
    if (!selected || !online || !document || !versionAvailable || taskLock.current) return;
    taskLock.current = true; setBusy("deleting"); setMessage("");
    try {
      const result = await runApiTask(() => api.deleteAigcChannel(selected.id, document.revision, document.credentialRevision), { operation: "删除 AIGC 渠道", expected: aigcExpected(setMessage) });
      if (result.status !== "success") return;
      setDocument({ ...document, channels: document.channels.filter((channel) => channel.id !== selected.id), revision: "", credentialRevision: "" });
      closeEditor();
      await runApiTask(async () => window.localStorage.removeItem(CACHE_KEY), { operation: "清除删除前的 AIGC 渠道缓存" });
      setMessage(await reload() ? "渠道已删除" : "渠道已删除，但列表尚未更新。请重新加载渠道后再修改配置。");
    } finally { taskLock.current = false; setBusy(undefined); }
  }

  /** 测试接口只接受已保存渠道标识，有脏草稿时明确禁止测试。 */
  async function test() {
    if (!selected || !online || dirty || taskLock.current || !versionAvailable) return;
    taskLock.current = true; setBusy("testing"); setMessage(""); setTestResult("");
    try {
      const result = await runApiTask(() => api.testAigcChannel(selected.id), { operation: "测试已保存 AIGC 渠道", expected: aigcExpected(setMessage) });
      if (result.status === "success") setTestResult(result.data.ok ? "已保存配置连接正常；不代表生成任务已验证。" : result.data.message);
    } finally { taskLock.current = false; setBusy(undefined); }
  }

  const channels = document?.channels ?? [];
  const templates = document?.channelTemplates ?? [];
  const selectedTemplate = templates.find((template) => template.type === draft.type);
  return <>
    <main className="configuration-page configuration-quick-wins-page aigc-channels-page" inert={Boolean(editor) || undefined} aria-hidden={Boolean(editor) || undefined}>
      <header className="configuration-page__heading configuration-page__heading--actions"><div><span className="configuration-eyebrow">AIGC CHANNELS</span><h1>AIGC 渠道</h1><p>管理生成服务的连接参数与凭证，供 AIGC 接口引用。</p></div><button type="button" data-aigc-channel-create className="configuration-primary-action" disabled={!writable} onClick={() => { closeEditor(); setMessage(""); setEditor("protocol"); }}><Plus size={15} />新增渠道</button></header>
      {!editor && message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="aigc-channel-list" aria-labelledby="aigc-channel-list-title" aria-busy={loading}>
        <div className="aigc-channel-list__heading"><h2 id="aigc-channel-list-title">已配置渠道 <small>{versionAvailable ? `${channels.length} 个` : "尚未同步"}</small></h2><span>{loading ? "正在加载渠道…" : "选择渠道进行编辑"}</span></div>
        {channels.map((channel) => <article key={channel.id} className="aigc-channel-row"><div><h3>{channel.name}</h3><dl><div><dt>协议</dt><dd>{channel.type}</dd></div><div><dt>超时</dt><dd>{channel.timeoutMs === undefined ? "不限制" : `${channel.timeoutMs / 1000} 秒`}</dd></div></dl><small>{channel.baseUrl || "未配置地址"}</small><span className="aigc-channel-state">{channel.enabled ? "已启用" : "已停用"}</span><span className="aigc-channel-state">{channel.hasApiKey ? "密钥已配置" : channel.type === "comfyui" ? "密钥未配置（可选）" : "密钥未配置"}</span></div><button type="button" className="configuration-secondary-action" aria-label={`编辑${channel.name}`} disabled={loading || Boolean(busy) || !versionAvailable} onClick={() => select(channel)}><Pencil size={15} />编辑</button></article>)}
        {!channels.length && !loading && versionAvailable ? <div className="aigc-channel-empty"><h3>尚未配置 AIGC 渠道</h3><p className="configuration-help">点击“新增渠道”，先选择协议，再填写连接参数与凭证。</p></div> : null}
      </section>
      <p className="configuration-help">启用和密钥状态表示配置事实，不代表连接测试通过或 Agent 已获授权。</p>
      {!versionAvailable && !loading ? <button type="button" className="configuration-secondary-action" disabled={!online || Boolean(busy)} onClick={() => void (async () => { if (await reload()) setMessage("渠道列表已重新加载"); })()}>重新加载渠道</button> : null}
    </main>
    {editor ? <ConfigurationEditorDialog variant="drawer" classPrefix="aigc-channel" closeLabel="关闭渠道编辑" returnFocusSelector="[data-aigc-channel-create]"
      title={selected ? `编辑渠道 · ${selected.name}` : "新增渠道"} description={editor === "protocol" ? "先选择接入协议，再配置连接参数。" : "协议决定请求格式，保存后返回渠道列表。"}
      busy={Boolean(busy)} suspended={guard.pending || deleteOpen} onClose={() => guard.request(closeEditor)}
      footer={<><span className="configuration-editing-state">{dirty ? "有未保存的修改" : editor === "protocol" ? "选择一种协议继续" : selected ? "当前没有未保存的修改" : "新建草稿"}</span><div>{!selected && editor === "connection" ? <button type="button" className="configuration-secondary-action" disabled={Boolean(busy)} onClick={() => guard.request(() => { closeEditor(); setMessage(""); setEditor("protocol"); })}>重新选协议</button> : null}<button type="button" className="configuration-secondary-action" disabled={Boolean(busy)} onClick={() => guard.request(closeEditor)}>取消</button>{editor === "connection" ? <button type="button" className="configuration-primary-action" disabled={!writable} onClick={() => void (async () => { if (await save()) closeEditor(); })()}><Save size={16} />{busy === "saving" ? "保存中…" : selected ? "保存更改" : "创建渠道"}</button> : null}</div></>}>
      {editor === "protocol" ? <section className="aigc-channel-protocols"><h3>选择接入协议</h3>{templates.map((template) => <button type="button" key={template.id} className="aigc-channel-protocol" aria-label={`新建 ${template.name} 渠道`} disabled={!writable} onClick={() => createDraft(template)}><strong>{template.name}</strong><span>{template.type}</span><small>{channelProtocolDescription(template.type)}</small></button>)}</section> : <>
        <fieldset className="configuration-interaction-fields" disabled={Boolean(busy)}><h3>连接参数与凭证</h3><div className="aigc-channel-fields">
          <label><span>协议</span><input aria-label="AIGC 渠道协议" value={draft.type} readOnly /></label>
          <p className="configuration-help">{channelProtocolDescription(draft.type)}。协议由新建时确定，编辑阶段不可切换；如需更换请新建渠道。</p>
          <label><span>渠道名称</span><input aria-label="AIGC 渠道名称" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
          <label><span>Base URL</span><input aria-label="AIGC Base URL" placeholder={selectedTemplate?.defaultBaseUrl} value={draft.baseUrl} onChange={(event) => updateDraft("baseUrl", event.target.value)} /></label>
          <label><span>请求超时（毫秒）{draft.type === "comfyui" ? <small>留空表示不限制</small> : null}</span><input type="number" min={1000} max={300000} step={1000} aria-label="AIGC 请求超时" value={draft.timeoutMs ?? ""} onChange={(event) => updateDraft("timeoutMs", event.target.value === "" ? undefined : Number(event.target.value))} /></label>
          <label className="aigc-channel-check"><input type="checkbox" checked={draft.enabled} onChange={(event) => updateDraft("enabled", event.target.checked)} /><span>允许接口引用该渠道</span></label>
          <p className="configuration-help">{draft.type === "comfyui" ? "ComfyUI 通常在内网匿名运行；如上游启用了认证，可在这里填写 API Key。" : "OpenAI 与 Grok 渠道必须配置 API Key，密钥仅保存在服务端。"}</p>
          <label><span>API Key<small>{selected?.hasApiKey ? "留空则保留已配置密钥" : "仅保存到服务端"}</small></span><SecretInput aria-label="AIGC API Key" autoComplete="new-password" value={apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => { setApiKey(event.target.value); setTestResult(""); }} /></label>
        </div></fieldset>
        {selected ? <><section className="aigc-channel-test"><h3>连接测试</h3><p className="configuration-help">{dirty ? "有未保存修改，请先保存。测试只使用已保存参数与密钥。" : "测试使用已保存参数与密钥，不测试草稿。"}</p><button type="button" className="configuration-secondary-action" disabled={!writable || dirty} onClick={() => void test()}><TestTube2 size={15} />{busy === "testing" ? "测试中…" : "测试已保存配置"}</button>{testResult ? <p className="configuration-help" role="status">{testResult}</p> : null}</section><section className="aigc-channel-danger"><div><h3>删除渠道</h3><p className="configuration-help">凭证一并删除；仍被接口引用时不能删除。</p></div><button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!writable} onClick={() => { setMessage(""); setDeleteOpen(true); }}><Trash2 size={15} />删除渠道</button></section></> : null}
      </>}
      {message && !deleteOpen ? <p className="configuration-help" role="status">{message}</p> : null}
    </ConfigurationEditorDialog> : null}
    {guard.dialog}
    {deleteOpen && selected ? <ConfigurationEditorDialog variant="confirmation" classPrefix="aigc-channel" returnFocusSelector="[data-aigc-channel-create]" title={`删除渠道“${selected.name}”？`}
      description={`渠道与凭证将一并删除，无法恢复。仍被 AIGC 接口引用时不能删除，请先解除引用。${dirty ? "当前未保存的修改也会丢弃。" : ""}`}
      busy={Boolean(busy)} onClose={() => setDeleteOpen(false)} footer={<><button type="button" className="configuration-secondary-action" disabled={Boolean(busy)} onClick={() => setDeleteOpen(false)}>取消</button><button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!writable} onClick={() => void remove()}>{busy === "deleting" ? "删除中…" : "确认删除"}</button></>}>
      {message ? <p className="configuration-inline-error" role="alert">{message}</p> : null}
    </ConfigurationEditorDialog> : null}
  </>;
}

/** 用简短的业务描述帮助用户区分协议能力边界。 */
function channelProtocolDescription(type: AigcChannelType): string {
  if (type === "openai") return "标准 OpenAI 图片与编辑接口";
  if (type === "grok") return "OpenAI 兼容的图片与视频接口";
  return "导入工作流后按节点编排执行";
}

/** 可恢复业务错误保留原草稿，用户修正参数或解除引用后继续操作。 */
function aigcExpected(setMessage: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setMessage(error.message);
  return { VERSION_CONFLICT: show, VALIDATION_FAILED: show, CREDENTIAL_NOT_FOUND: show, NOT_FOUND: show };
}

/** 只缓存脱敏配置；无有效双版本的缓存不能恢复为可写配置。 */
function readCache(): AigcSettingsDocument | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "");
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as Partial<AigcSettingsDocument>;
    if (typeof value.revision !== "string" || !value.revision || typeof value.credentialRevision !== "string" || !value.credentialRevision) return undefined;
    if (!Array.isArray(value.channels) || !Array.isArray(value.channelTemplates) || !Array.isArray(value.credentials)) return undefined;
    return parsed as AigcSettingsDocument;
  } catch { return undefined; }
}
