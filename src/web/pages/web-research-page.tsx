import { Button } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { Save } from "lucide-react";
import { useEffect, useState } from "react";

import type { SearchProviderConfig, WebResearchConfig, WebResearchGlobalConfig, WebResearchSettingsDocument } from "../../shared/web-research-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { ConflictDialog, type ConfigurationDifference } from "../components/configuration/conflict-dialog";
import { GlobalSearchPolicyPanel } from "../components/web-research/global-search-policy-panel";
import { SearchProviderDialog } from "../components/web-research/search-provider-dialog";
import { SearchProviderList } from "../components/web-research/search-provider-list";
import { useOnlineStatus } from "../use-online-status";
import { webResearchExpected } from "../web-research-error-policy";
import "../configuration.css";

type ProviderDialogState =
  | { mode: "create" }
  | { mode: "edit"; provider: SearchProviderConfig };

interface GlobalConflictState {
  latest: WebResearchSettingsDocument;
  differences: ConfigurationDifference[];
}

/** 协调服务状态、渠道事务和全局策略三个互不覆盖的配置作用域。 */
export function WebResearchPage() {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [document, setDocument] = useState<WebResearchSettingsDocument>();
  const [globalDraft, setGlobalDraft] = useState<WebResearchGlobalConfig>();
  const [dialog, setDialog] = useState<ProviderDialogState>();
  const [globalError, setGlobalError] = useState("");
  const [notice, setNotice] = useState("");
  const [savingGlobal, setSavingGlobal] = useState(false);
  const [conflict, setConflict] = useState<GlobalConflictState>();

  useEffect(() => {
    let active = true;
    void runApiTask(api.getWebResearch, { operation: "加载联网搜索配置" }).then((result) => {
      if (result.status !== "success") return;
      const next = result.data;
      if (!active) return;
      setDocument(next);
      setGlobalDraft(globalConfigOf(next.config));
    });
    return () => { active = false; };
  }, [runApiTask]);

  const saveGlobal = async (revision = document?.revision) => {
    if (!document || !globalDraft || !revision) return;
    setSavingGlobal(true);
    setGlobalError("");
    setNotice("");
    try {
      const result = await runApiTask(
        () => api.updateWebResearchGlobal(revision, globalDraft),
        {
          operation: "保存联网搜索全局设置",
          expected: {
            ...webResearchExpected(setGlobalError),
            VERSION_CONFLICT: async () => {
              const latest = await api.getWebResearch();
              setConflict({ latest, differences: collectDifferences(globalDraft, globalConfigOf(latest.config)) });
            },
          },
        },
      );
      if (result.status !== "success") return;
      const next = result.data;
      setDocument(next);
      setGlobalDraft(globalConfigOf(next.config));
      setConflict(undefined);
      setNotice("全局设置已保存");
    } finally {
      setSavingGlobal(false);
    }
  };

  const reloadAfterDelete = async () => {
    const result = await runApiTask(api.getWebResearch, { operation: "删除渠道后刷新联网搜索配置" });
    if (result.status === "success") {
      const next = result.data;
      setDocument(next);
      setNotice("渠道已删除");
    }
  };

  if (!document || !globalDraft) {
    return <main className="configuration-page"><header className="configuration-page__heading"><span className="configuration-eyebrow">WEB RESEARCH</span><h1>联网搜索</h1></header><p className={globalError ? "configuration-inline-error" : "configuration-help"}>{globalError || "正在读取联网搜索配置…"}</p></main>;
  }

  const enabledProviders = document.config.searchProviders.filter((provider) => provider.enabled);
  const missingCredential = enabledProviders.find((provider) => provider.type !== "searxng" && !hasCredential(document, provider.id));
  const noEnabledProvider = enabledProviders.length === 0;
  const blocked = globalDraft.enabled && (noEnabledProvider || Boolean(missingCredential));
  const dirty = JSON.stringify(globalDraft) !== JSON.stringify(globalConfigOf(document.config));

  return <main className="configuration-page web-research-page">
    {conflict ? <ConflictDialog differences={conflict.differences} onReload={() => {
      setDocument(conflict.latest);
      setGlobalDraft(globalConfigOf(conflict.latest.config));
      setConflict(undefined);
    }} onReapply={() => void saveGlobal(conflict.latest.revision)} /> : null}
    <header className="configuration-page__heading"><span className="configuration-eyebrow">WEB RESEARCH</span><h1>联网搜索</h1><p>统一管理服务可用性、渠道故障切换顺序，以及适用于全部渠道的检索策略。</p></header>

    <section className="configuration-form-card">
      <div className="configuration-section__heading"><div><span>01</span><h2>服务状态</h2></div><small>{enabledProviders.length} 个已启用渠道</small></div>
      <label className="configuration-capability-toggle"><span>启用联网搜索<small>启用后，已授权 Agent 才能使用联网工具。</small></span><Checkbox aria-label="启用联网搜索" checked={globalDraft.enabled} onChange={(event) => { setGlobalDraft({ ...globalDraft, enabled: event.target.checked }); setGlobalError(""); setNotice(""); }} /></label>
      {globalDraft.enabled && noEnabledProvider ? <p className="configuration-inline-error" role="alert">至少启用一个搜索渠道后才能保存。</p> : null}
      {globalDraft.enabled && missingCredential ? <p className="configuration-inline-error" role="alert">“{missingCredential.name}”缺少 API Key，请配置凭证或停用该渠道。</p> : null}
    </section>

    <SearchProviderList document={document} online={online} onAdd={() => { setDialog({ mode: "create" }); setNotice(""); }} onConfigure={(provider) => { setDialog({ mode: "edit", provider }); setNotice(""); }} onDocumentChange={(next) => { setDocument(next); setNotice(""); }} />
    <GlobalSearchPolicyPanel value={globalDraft} egressProfiles={document.egressProfiles} error={globalError} onChange={(next) => { setGlobalDraft(next); setGlobalError(""); setNotice(""); }} />

    {notice ? <p className="configuration-help" role="status">{notice}</p> : null}
    <div className="configuration-save-bar"><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || savingGlobal || !dirty || blocked} onClick={() => void saveGlobal()}><Save size={16} aria-hidden="true" />{savingGlobal ? "保存中…" : "保存全局设置"}</Button></div>

    {dialog ? <SearchProviderDialog
      mode={dialog.mode}
      document={document}
      provider={dialog.mode === "edit" ? dialog.provider : undefined}
      online={online}
      onSaved={(next) => { setDocument(next); setDialog(undefined); setNotice(dialog.mode === "create" ? "渠道已添加" : "渠道已保存"); }}
      onDeleted={() => { setDialog(undefined); void reloadAfterDelete(); }}
      onClose={() => setDialog(undefined)}
    /> : null}
  </main>;
}

/** 从持久化配置中明确剔除渠道列表，建立全局保存边界。 */
function globalConfigOf(config: WebResearchConfig): WebResearchGlobalConfig {
  return {
    enabled: config.enabled,
    webRead: { ...config.webRead },
    maxResults: config.maxResults,
    maxTextLength: config.maxTextLength,
    maxRedirects: config.maxRedirects,
    maxResponseBytes: config.maxResponseBytes,
    httpsOnly: config.httpsOnly,
    allowedDomains: [...config.allowedDomains],
    allowedContentTypes: [...config.allowedContentTypes],
  };
}

function hasCredential(document: WebResearchSettingsDocument, providerId: string): boolean {
  return document.credentials.some((status) => status.providerId === providerId && status.configured);
}

function collectDifferences(local: WebResearchGlobalConfig, disk: WebResearchGlobalConfig): ConfigurationDifference[] {
  return (Object.keys(local) as Array<keyof WebResearchGlobalConfig>)
    .filter((field) => JSON.stringify(local[field]) !== JSON.stringify(disk[field]))
    .map((field) => ({ field, local: local[field], disk: disk[field] }));
}
