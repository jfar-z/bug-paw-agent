import { Button } from "../../ui/controls";
import { CheckCircle2, RefreshCw } from "lucide-react";
import { useSyncExternalStore } from "react";
import { navigateTo } from "../../router";
import "../../configuration-interactions.css";

/** 仅记录本次页面会话中已确认的保存或刷新结果，不推断服务器全局状态。 */
let changes: Readonly<Record<string, { generation: number; pending: boolean }>> = {};
let generation = 0;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const snapshot = () => changes;

/** 根据接口的实际结果登记配置状态，不写入任何配置内容或凭证。 */
export function recordConfigurationSave(key: string, pending = true) {
  changes = { ...changes, [key]: { generation: ++generation, pending } };
  listeners.forEach((listener) => listener());
}

/** 记录刷新请求开始时的版本，避免并发保存被较早的刷新结果误标为已应用。 */
export function configurationRefreshGeneration() { return generation; }

/** 仅在核心刷新接口成功后确认请求开始前的已保存配置。 */
export function confirmConfigurationRefresh(throughGeneration: number) {
  changes = Object.fromEntries(Object.entries(changes).map(([key, value]) => [key, value.generation <= throughGeneration ? { ...value, pending: false } : value]));
  listeners.forEach((listener) => listener());
}

/** 未确认运行状态时只解释生效方式；未保存、待刷新和已确认应用分别呈现。 */
export function ConfigurationEffectNotice({ configKey, dirty = false }: { configKey?: string; dirty?: boolean }) {
  const state = useSyncExternalStore(subscribe, snapshot);
  const saved = configKey ? state[configKey] : undefined;
  const pending = configKey ? saved?.pending === true : Object.values(state).some((value) => value.pending);
  const applied = !dirty && !pending && (configKey ? saved?.pending === false : Object.keys(state).length > 0);
  const title = dirty ? "有未保存的修改" : pending ? "配置已保存，等待应用" : applied ? "本次已保存配置已应用" : "配置生效方式";
  const description = dirty ? "先保存当前修改；需要刷新核心配置的更改，保存后会显示生效提示。"
    : pending ? "本次更改已保存到配置文件，请到系统诊断刷新核心配置后应用到运行中的 Agent。"
    : applied ? "本次会话中已保存的更改已完成核心刷新，或接口已确认自动应用。"
    : "需要刷新核心配置的更改，保存后请到系统诊断确认并刷新。此提示不代表当前运行状态。";
  return <section className={applied ? "configuration-effect-notice is-applied" : "configuration-effect-notice"} role="status">
    {applied ? <CheckCircle2 size={20} aria-hidden="true" /> : <RefreshCw size={20} aria-hidden="true" />}
    <div><strong>{title}</strong><p>{description}</p></div>
    {configKey ? <Button type="button" className="configuration-secondary-action" onClick={() => navigateTo({ page: "diagnostics" })}>前往系统诊断 →</Button> : null}
  </section>;
}
