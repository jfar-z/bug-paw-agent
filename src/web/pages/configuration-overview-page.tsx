import { Button } from "../ui/controls";
import { ArrowRight, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { ConfigurationOverviewDocument } from "../../shared/configuration-operations-contracts";
import { api, ApiClientError } from "../api";
import { useApiTask } from "../api-task-provider";
import { useErrorToast } from "../error-toast-provider";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import type { AppRoute } from "../router";
import { configurationGroups } from "../configuration-navigation";
import { ConfigurationEffectNotice } from "../components/configuration/configuration-effect-notice";
import { useOnlineStatus } from "../use-online-status";
import "../configuration.css";
import "../configuration-maintenance.css";

const CACHE_KEY = "bugpaw:configuration-overview:v1";

/** 业务入口与脱敏摘要共享真实元数据，读取失败和旧缓存不冒充运行健康。 */
export function ConfigurationOverviewPage({ onNavigate }: { onNavigate: (route: AppRoute) => void }) {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const controller = useRef({ runApiTask, toast });
  controller.current = { runApiTask, toast };
  const online = useOnlineStatus();
  const [document, setDocument] = useState<ConfigurationOverviewDocument>();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [reload, setReload] = useState(0);
  const [cached, setCached] = useState(false);
  useEffect(() => {
    let active = true;
    setState("loading");
    void controller.current.runApiTask(api.getConfigurationOverview, { operation: "读取配置概览摘要" }).then((result) => {
      if (!active) return;
      if (result.status !== "success") {
        setState("error");
        // 读取失败允许展示脱敏旧摘要，但始终保留错误与非实时提示。
        try {
          const value = JSON.parse(localStorage.getItem(CACHE_KEY) ?? "null") as ConfigurationOverviewDocument | null;
          if (value && typeof value.readAt === "string" && Array.isArray(value.entries)) { setDocument(value); setCached(true); }
        } catch { /* 损坏的非业务缓存直接忽略，不覆盖原读取错误。 */ }
        return;
      }
      setDocument(result.data); setCached(false); setState("ready");
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...result.data, entries: result.data.entries.filter((entry) => !entry.error) }));
      for (const entry of result.data.entries) if (entry.error) controller.current.toast.push(toUnexpectedErrorNotice(new ApiClientError("INTERNAL_ERROR", entry.error.message, 500, entry.error.requestId), "读取配置摘要"));
    });
    return () => { active = false; };
  }, [reload]);
  const entries = document?.entries ?? [];
  return <main className="configuration-page configuration-maintenance-page configuration-overview-page">
    <header className="configuration-page__heading"><div><span className="configuration-eyebrow">CONFIGURATION OVERVIEW</span><h1>配置中心</h1><p>查看已保存配置，按业务任务进入设置。</p></div><img className="configuration-overview-mascot" src="/brand/bugpaw/bugpaw-mascot.png" alt="BUG 猫咪像素吉祥物" /></header>
    <ConfigurationEffectNotice />
    <p className="maintenance-muted">生效提示仅记录本次页面会话，不代表服务器全局状态。</p>
    <div className="maintenance-row"><p className="maintenance-muted">{document ? `${cached || !online ? "缓存摘要（非实时）" : "摘要读取时间"}：${new Date(document.readAt).toLocaleString()}` : "正在读取配置摘要…"}</p><Button type="button" className="configuration-secondary-action" disabled={!online || state === "loading"} onClick={() => setReload((value) => value + 1)}><RefreshCw size={16} />刷新摘要</Button></div>
    {state === "error" ? <p className="configuration-inline-error" role="alert">配置摘要读取未完成，请查看错误通知并重新加载；保留的旧摘要不代表当前状态。</p> : null}
    {entries.some((entry) => entry.needsConfiguration) ? <section className="configuration-form-card"><h2>待配置项</h2><p>{entries.filter((entry) => entry.needsConfiguration).map((entry) => configurationGroups.flatMap((group) => group.entries).find((item) => item.key === entry.key)?.title).filter(Boolean).join("、")}尚未配置。</p></section> : null}
    {configurationGroups.map((group) => <section key={group.title} className="configuration-overview-group" aria-label={group.title}><h2>{group.title}</h2><div className="configuration-entry-list">{group.entries.map((entry) => {
      const summary = entries.find((item) => item.key === entry.key);
      return <div key={entry.key}><button type="button" className="configuration-entry" onClick={() => onNavigate(entry.route)}><span><strong>{entry.title}</strong><small>{summary?.error ? `读取失败：${summary.error.message}` : summary?.summary ?? (state === "loading" ? "正在读取…" : entry.description)}</small></span><ArrowRight size={18} aria-hidden="true" /></button>{summary?.error ? <button type="button" className="text-button" disabled={!online || state === "loading"} onClick={() => setReload((value) => value + 1)}>重试{entry.title}摘要</button> : null}</div>;
    })}</div></section>)}
    <p className="maintenance-muted">配置数量和启停不代表连接测试通过、Agent 授权或索引已最新。刷新摘要不会执行连接测试或核心刷新。</p>
  </main>;
}
