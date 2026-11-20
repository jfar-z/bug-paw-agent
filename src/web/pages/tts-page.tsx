import { Button, Textarea, TextField } from "../ui/controls";
import { SearchSelect } from "../ui/search-select";
import { Pencil, Plus, Save, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { TtsProfileInput, TtsProfileSummary } from "../../shared/tts-contracts";
import { api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { ConfigurationEditorDialog as TtsDialog } from "../components/configuration/configuration-editor-dialog";
import { useUnsavedChanges } from "../ui/unsaved-changes";
import "../configuration-interactions.css";
import { SecretInput } from "../ui/secret-input";
import { formatTtsCustomParameters, parseTtsCustomParametersText } from "../tts-custom-parameters-form";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../tts.css";

const emptyDraft = (): TtsProfileInput => ({ name: "", baseUrl: "", model: "", voice: "", responseFormat: "mp3", customParameters: {}, apiKey: "" });
const CACHE_KEY = "pi-agent:tts-cache";

/** 配置多个 OpenAI 兼容的语音合成接口。 */
export function TtsPage() {
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [profiles, setProfiles] = useState<TtsProfileSummary[]>([]);
  const [revision, setRevision] = useState("");
  const [selected, setSelected] = useState<TtsProfileSummary>();
  const [draft, setDraft] = useState<TtsProfileInput>(emptyDraft);
  const [customParametersText, setCustomParametersText] = useState("{}");
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [message, setMessage] = useState("");
  const [task, setTask] = useState<"save" | "delete" | "credential">();
  const saving = Boolean(task);
  const taskLock = useRef(false);
  const [loading, setLoading] = useState(true);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [parametersOpen, setParametersOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [savedDraft, setSavedDraft] = useState<TtsProfileInput>(emptyDraft);
  const [savedParameters, setSavedParameters] = useState("{}");
  const [revealedKey, setRevealedKey] = useState("");
  const editorOpen = creating || Boolean(selected);
  const dirty = (creating || Boolean(selected)) && (JSON.stringify({ ...draft, apiKey: "" }) !== JSON.stringify({ ...savedDraft, apiKey: "" })
    || customParametersText !== savedParameters || Boolean(draft.apiKey && draft.apiKey !== revealedKey));
  const guard = useUnsavedChanges({ dirty, busy: saving || deleteOpen, label: selected ? `语音配置 · ${selected.name}` : "新增语音配置", save, canSave: online });
  useEffect(() => {
    let active = true;
    const cached = readCache();
    if (cached) { setProfiles(cached.profiles); setRevision(cached.revision); }
    void (async () => {
      const result = cached
        ? await runOptionalApiTask(api.getTtsProfiles, {
            operation: "加载语音配置",
            fallbackReason: "正在显示上次缓存的配置；离线时不能保存。",
            fallback: () => cached,
          })
        : await runApiTask(api.getTtsProfiles, { operation: "加载语音配置" });
      if (!active) return;
      if (result.status === "success" || result.status === "fallback") {
        const document = result.data;
        setProfiles(document.profiles); setRevision(document.revision);
        if (result.status === "success") await cacheProfiles(document);
        else setMessage(result.reason);
      }
      if (active) setLoading(false);
    })();
    return () => { active = false; };
  }, [runApiTask, runOptionalApiTask]);

  /** 缓存失败单独报告，不把已成功的服务端写入误判成失败。 */
  async function cacheProfiles(document: { revision: string; profiles: TtsProfileSummary[] }) {
    await runApiTask(async () => window.localStorage.setItem(CACHE_KEY, JSON.stringify(document)), { operation: "更新语音配置的离线摘要" });
  }

  /** 刷新成功后取得最新版本，失败时禁止继续使用失效版本写入。 */
  async function reload() {
    setLoading(true);
    try {
      const result = await runApiTask(api.getTtsProfiles, { operation: "刷新语音配置列表" });
      if (result.status !== "success") return false;
      setProfiles(result.data.profiles); setRevision(result.data.revision);
      await cacheProfiles(result.data);
      return true;
    } finally { setLoading(false); }
  }

  /** 显式编辑单项配置，不因加载列表而自动打开第一项。 */
  function select(profile: TtsProfileSummary) {
    const next = { name: profile.name, baseUrl: profile.baseUrl, model: profile.model, voice: profile.voice, responseFormat: profile.responseFormat, customParameters: profile.customParameters ?? {}, apiKey: "" };
    const parameters = formatTtsCustomParameters(profile.customParameters);
    setSelected(profile); setCreating(false); setDraft(next); setSavedDraft(next);
    setCustomParametersText(parameters); setSavedParameters(parameters); setApiKeyVisible(false); setRevealedKey(""); setParametersOpen(false); setMessage("");
  }

  /** 显式进入新建模式，空列表不隐式提交新配置。 */
  function create() {
    const next = emptyDraft();
    setSelected(undefined); setCreating(true); setDraft(next); setSavedDraft(next);
    setCustomParametersText("{}"); setSavedParameters("{}"); setApiKeyVisible(false); setRevealedKey(""); setParametersOpen(false); setMessage("");
  }

  /** 关闭时清除内存凭证；调用方必须先经过未保存保护。 */
  function closeEditor() {
    setSelected(undefined); setCreating(false); setDraft(emptyDraft()); setSavedDraft(emptyDraft());
    setCustomParametersText("{}"); setSavedParameters("{}"); setApiKeyVisible(false); setRevealedKey("");
    setDeleteOpen(false); setParametersOpen(false);
  }

  const update = <K extends keyof TtsProfileInput>(key: K, value: TtsProfileInput[K]) => setDraft((current) => ({ ...current, [key]: value }));
  const toggleApiKeyVisibility = async () => {
    if (taskLock.current) return;
    if (apiKeyVisible) { setApiKeyVisible(false); return; }
    if (!selected?.hasApiKey || draft.apiKey) { setApiKeyVisible(true); return; }
    taskLock.current = true; setTask("credential");
    try {
      const result = await runApiTask(() => api.getTtsProfileCredential(selected.id), { operation: "读取语音 API Key", expected: ttsExpected(setMessage) });
      if (result.status === "success") { update("apiKey", result.data.apiKey); setRevealedKey(result.data.apiKey); setApiKeyVisible(true); }
    } finally { taskLock.current = false; setTask(undefined); }
  };
  /** 保存响应直接更新列表与版本，保护新建重试和凭证保留语义。 */
  async function save(): Promise<boolean> {
    if (!online || taskLock.current || !revision || (!selected && !creating)) return false;
    let customParameters;
    try {
      customParameters = parseTtsCustomParametersText(customParametersText);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "TTS 自定义请求参数无效");
      setParametersOpen(true);
      return false;
    }
    const input = { ...draft, customParameters };
    taskLock.current = true; setTask("save"); setMessage("");
    try {
      const result = await runApiTask(
        () => selected ? api.updateTtsProfile(selected.id, revision, input) : api.createTtsProfile(input),
        { operation: "保存语音配置", expected: ttsExpected(setMessage) },
      );
      if (result.status !== "success") return false;
      // 保存响应带确切对象与 revision，避免重读失败后误判可重新创建。
      const current = result.data.profile;
      const nextProfiles = selected ? profiles.map((item) => item.id === current.id ? current : item) : [...profiles, current];
      setProfiles(nextProfiles); setRevision(result.data.revision);
      select(current);
      await cacheProfiles({ profiles: nextProfiles, revision: result.data.revision });
      setMessage(selected ? "语音配置修改已保存" : "语音配置已创建");
      return true;
    } catch (error) {
      await runApiTask(async () => { throw error; }, { operation: "刷新语音配置" });
      return false;
    }
    finally { taskLock.current = false; setTask(undefined); }
  }
  /** 删除成功立即移除对象；列表重读失败仅阻止后续写入，不重复删除。 */
  async function remove() {
    if (!selected || !online || taskLock.current || !revision) return;
    taskLock.current = true; setTask("delete"); setMessage("");
    try {
      const result = await runApiTask(
        () => api.deleteTtsProfile(selected.id, revision),
        { operation: "删除语音配置", expected: ttsExpected(setMessage) },
      );
      if (result.status !== "success") return;
      setProfiles((current) => current.filter((profile) => profile.id !== selected.id));
      setRevision(""); closeEditor();
      await runApiTask(async () => window.localStorage.removeItem(CACHE_KEY), { operation: "清除删除前的语音配置缓存" });
      const refreshed = await reload();
      setMessage(refreshed ? "已删除语音配置" : "语音配置已删除，但列表尚未更新。请重新加载列表后再修改配置。");
    } finally { taskLock.current = false; setTask(undefined); }
  }

  const writable = online && !loading && !saving && Boolean(revision);
  const parameterSummary = summarizeParameters(customParametersText);
  return <>
    <main className="configuration-page configuration-quick-wins-page tts-page" inert={editorOpen || undefined} aria-hidden={editorOpen || undefined}>
      <header className="configuration-page__heading configuration-page__heading--actions"><div><span className="configuration-eyebrow">TEXT TO SPEECH</span><h1>语音合成</h1><p>管理 OpenAI Speech 兼容接口，供 Agent 选择使用。</p></div><Button variant="primary" type="button" data-tts-create className="configuration-primary-action" onClick={create} disabled={!writable}><Plus size={15} />新增语音配置</Button></header>
      {!editorOpen && message ? <p className="configuration-help" role="status">{message}</p> : null}
      <section className="tts-profile-list" aria-labelledby="tts-list-title" aria-busy={loading}>
        <div className="tts-list-heading"><h2 id="tts-list-title">语音配置 <small>{revision ? `${profiles.length} 项` : "尚未加载"}</small></h2><span>{loading ? "正在加载配置…" : "选择配置进行编辑"}</span></div>
        {profiles.map((profile) => <article key={profile.id} className="tts-profile"><div><h3>{profile.name}</h3><dl><div><dt>模型</dt><dd>{profile.model}</dd></div><div><dt>音色</dt><dd>{profile.voice}</dd></div><div><dt>格式</dt><dd>{profile.responseFormat.toUpperCase()}</dd></div></dl><small>{profile.baseUrl}</small><span className="tts-key-state">{profile.hasApiKey ? "密钥已配置" : "未配置密钥"}</span></div><Button type="button" className="configuration-secondary-action" aria-label={`编辑${profile.name}`} disabled={loading || saving || !revision} onClick={() => select(profile)}><Pencil size={15} />编辑</Button></article>)}
        {!profiles.length && !loading && revision ? <div className="tts-empty"><h3>尚未配置语音模型</h3><p className="configuration-help">点击“新增语音配置”创建配置，再到 Agent 中选择使用。</p></div> : null}
      </section>
      <p className="configuration-help">密钥状态仅表示是否已配置，不代表接口连接或语音合成测试通过。密钥默认隐藏，可在编辑时按需查看。</p>
      {!revision && !loading ? <Button type="button" className="configuration-secondary-action" disabled={!online || saving} onClick={() => void (async () => { if (await reload()) setMessage("语音配置列表已更新"); })()}>重新加载语音配置</Button> : null}
    </main>
    {editorOpen ? <TtsDialog variant="drawer" title={selected ? `编辑语音配置 · ${selected.name}` : "新增语音配置"}
      description={selected ? "修改接口与默认语音参数，保存后返回配置列表。" : "创建接口连接与默认语音参数，供 Agent 选择使用。"}
      busy={saving} suspended={guard.pending || deleteOpen} onClose={() => guard.request(closeEditor)}
      footer={<><span className="configuration-editing-state">{dirty ? "有未保存的修改" : creating ? "新建草稿" : "当前没有未保存的修改"}</span><div><Button type="button" className="configuration-secondary-action" disabled={saving} onClick={() => guard.request(closeEditor)}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!writable} onClick={() => void (async () => { if (await save()) closeEditor(); })()}><Save size={16} />{task === "save" ? "保存中…" : selected ? "保存更改" : "创建语音配置"}</Button></div></>}>
      <fieldset className="configuration-interaction-fields" disabled={saving}>
        <h3>接口与语音</h3><p className="configuration-help">设置连接地址与默认语音参数。</p>
        <div className="tts-editor-fields">
          <label><span>配置名称</span><TextField aria-label="配置名称" value={draft.name} onChange={(event) => update("name", event.target.value)} /></label>
          <label><span>API Base URL</span><TextField aria-label="API Base URL" placeholder="https://example.com/v1" value={draft.baseUrl} onChange={(event) => update("baseUrl", event.target.value)} /></label>
          <label><span>模型</span><TextField aria-label="TTS 模型" value={draft.model} onChange={(event) => update("model", event.target.value)} /></label>
          <label><span>音色</span><TextField aria-label="音色" value={draft.voice} onChange={(event) => update("voice", event.target.value)} /></label>
          <label><span>音频格式</span><SearchSelect
            ariaLabel="音频格式"
            value={draft.responseFormat}
            onChange={(next) => update("responseFormat", next as TtsProfileInput["responseFormat"])}
            options={[
              { value: "mp3", label: "MP3" },
              { value: "opus", label: "Opus" },
              { value: "wav", label: "WAV" },
              { value: "pcm", label: "PCM" },
            ]}
          /></label>
          <label><span>API Key<small>{selected?.hasApiKey ? "留空则保留已配置密钥" : "仅保存到服务端"}</small></span><SecretInput aria-label="TTS API Key" autoComplete="new-password" value={draft.apiKey} visible={apiKeyVisible} onVisibilityChange={() => void toggleApiKeyVisibility()} onChange={(event) => update("apiKey", event.target.value)} /></label>
        </div>
        <p className="configuration-help">本应用当前仅对 PCM 启用边接收边播放。需要低延时时请选择 PCM，并确认上游接口支持 24 kHz、16 位小端单声道 PCM 的分块流式响应。</p>
        <details open={parametersOpen} onToggle={(event) => setParametersOpen(event.currentTarget.open)}><summary>高级请求参数 <small>{parameterSummary}</small></summary><label className="tts-parameters"><span>自定义请求参数（JSON）<small>模型级参数会覆盖上方默认字段</small></span><Textarea aria-label="TTS 自定义请求参数" rows={7} spellCheck={false} value={customParametersText} onChange={(event) => setCustomParametersText(event.target.value)} /></label>
          <p className="configuration-help">仅填写请求体参数，例如 <code>instructions</code> 或 <code>response_format</code>。不能覆盖 <code>input</code>，也不要填写 API Key、账号或身份信息。</p></details>
      </fieldset>
      {selected ? <section className="tts-danger-zone"><div><h3>删除配置</h3><p className="configuration-help">删除后无法恢复；被 Agent 使用的配置不能删除。</p></div><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!writable} onClick={() => { setMessage(""); setDeleteOpen(true); }}><Trash2 size={15} />删除配置</Button></section> : null}
      {message && !deleteOpen ? <p className="configuration-help" role="status">{message}</p> : null}
    </TtsDialog> : null}
    {guard.dialog}
    {deleteOpen && selected ? <TtsDialog variant="confirmation" title="删除语音配置？" description={`将删除“${selected.name}”，此操作无法恢复。${dirty ? "当前未保存的修改也会丢弃。" : ""}如果配置正被 Agent 使用，将阻止删除。`}
      busy={saving} onClose={() => setDeleteOpen(false)} footer={<><Button type="button" className="configuration-secondary-action" disabled={saving} onClick={() => setDeleteOpen(false)}>取消</Button><Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!writable} onClick={() => void remove()}>{task === "delete" ? "删除中…" : "确认删除"}</Button></>}>
      {message ? <p className="configuration-inline-error" role="alert">{message}</p> : null}
    </TtsDialog> : null}
  </>;

}

/** 将语音配置的可恢复业务错误保留在当前表单中。 */
function ttsExpected(setMessage: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setMessage(error.message);
  return {
    VERSION_CONFLICT: show,
    VALIDATION_FAILED: show,
    CREDENTIAL_NOT_FOUND: show,
    MODEL_IN_USE: show,
  };
}

/** 只缓存脱敏后的配置摘要，确保离线页不会落地密钥。 */
function readCache(): { revision: string; profiles: TtsProfileSummary[] } | undefined {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(CACHE_KEY) ?? "");
    if (!parsed || typeof parsed !== "object") return undefined;
    const value = parsed as { revision?: unknown; profiles?: unknown };
    if (typeof value.revision !== "string" || !Array.isArray(value.profiles)) return undefined;
    return { revision: value.revision, profiles: value.profiles as TtsProfileSummary[] };
  } catch { return undefined; }
}

/** 高级参数摘要只描述输入结构，不推断 Agent 最终请求或测试状态。 */
function summarizeParameters(text: string): string {
  try {
    const parameters = parseTtsCustomParametersText(text);
    const count = Object.keys(parameters).length;
    return count ? `已设置 ${count} 项参数` : "未设置额外参数";
  } catch { return "参数待校验"; }
}
