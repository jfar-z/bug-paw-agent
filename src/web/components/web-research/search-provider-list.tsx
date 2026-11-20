import { IconButton, Button } from "../../ui/controls";
import { ArrowDown, ArrowUp, Plus, Settings2 } from "lucide-react";
import { useState } from "react";

import type { SearchProviderConfig, WebResearchSettingsDocument } from "../../../shared/web-research-contracts";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { webResearchExpected } from "../../web-research-error-policy";

interface SearchProviderListProps {
  document: WebResearchSettingsDocument;
  online: boolean;
  onAdd(): void;
  onConfigure(provider: SearchProviderConfig): void;
  onDocumentChange(document: WebResearchSettingsDocument): void;
}

type OrderStatus =
  | { state: "idle" }
  | { state: "saving"; providerId: string }
  | { state: "saved"; providerId: string }
  | { state: "error"; providerId: string; message: string };

/** 展示搜索渠道路由顺序，并在移动后立即持久化完整 ID 排列。 */
export function SearchProviderList(props: SearchProviderListProps) {
  const { runApiTask } = useApiTask();
  const [orderStatus, setOrderStatus] = useState<OrderStatus>({ state: "idle" });

  const move = async (providerId: string, offset: -1 | 1) => {
    const previousDocument = props.document;
    const providers = previousDocument.config.searchProviders;
    const index = providers.findIndex((provider) => provider.id === providerId);
    const target = index + offset;
    if (index < 0 || target < 0 || target >= providers.length) return;
    const searchProviders = [...providers];
    [searchProviders[index], searchProviders[target]] = [searchProviders[target]!, searchProviders[index]!];
    const optimistic = { ...previousDocument, config: { ...previousDocument.config, searchProviders } };
    props.onDocumentChange(optimistic);
    setOrderStatus({ state: "saving", providerId });
    const result = await runApiTask(
      () => api.reorderWebResearchProviders(previousDocument.revision, searchProviders.map(({ id }) => id)),
      {
        operation: "调整搜索渠道顺序",
        expected: webResearchExpected((message) => setOrderStatus({ state: "error", providerId, message })),
      },
    );
    if (result.status === "success") {
      props.onDocumentChange(result.data);
      setOrderStatus({ state: "saved", providerId });
    } else {
      props.onDocumentChange(previousDocument);
      if (result.status !== "handled") setOrderStatus({ state: "idle" });
    }
  };

  const saving = orderStatus.state === "saving";
  return <section className="configuration-form-card">
    <div className="configuration-section__heading"><div><span>02</span><h2>已配置渠道</h2></div><Button type="button" className="configuration-secondary-action" disabled={!props.online || saving} onClick={props.onAdd}><Plus size={15} aria-hidden="true" />添加渠道</Button></div>
    {props.document.config.searchProviders.length > 0 ? <ol className="configuration-entry-list">
      {props.document.config.searchProviders.map((provider, index) => {
        const configured = props.document.credentials.some((status) => status.providerId === provider.id && status.configured);
        return <li className="configuration-entry" key={provider.id}>
          <span><strong>{provider.name}</strong><small>{providerTypeLabel(provider)} · {provider.enabled ? "已启用" : "已停用"}</small></span>
          <span><small>{provider.type === "searxng" ? "无需凭证" : configured ? "凭证已配置" : "缺少凭证"}</small></span>
          <div className="configuration-button-row">
            <IconButton label={`上移${provider.name}`} disabled={!props.online || saving || index === 0} onClick={() => void move(provider.id, -1)}><ArrowUp size={15} aria-hidden="true" /></IconButton>
            <IconButton label={`下移${provider.name}`} disabled={!props.online || saving || index === props.document.config.searchProviders.length - 1} onClick={() => void move(provider.id, 1)}><ArrowDown size={15} aria-hidden="true" /></IconButton>
            <Button type="button" className="configuration-secondary-action" aria-label={`配置${provider.name}`} disabled={!props.online || saving} onClick={() => props.onConfigure(provider)}><Settings2 size={14} aria-hidden="true" />配置</Button>
          </div>
        </li>;
      })}
    </ol> : <p className="configuration-help">尚未配置搜索渠道。</p>}
    {orderStatus.state === "saving" ? <p className="configuration-help" role="status">正在保存渠道顺序…</p> : null}
    {orderStatus.state === "saved" ? <p className="configuration-help" role="status">渠道顺序已保存</p> : null}
    {orderStatus.state === "error" ? <p className="configuration-inline-error" role="alert">{orderStatus.message}</p> : null}
  </section>;
}

function providerTypeLabel(provider: SearchProviderConfig): string {
  if (provider.type === "bocha") return "博查 Web Search";
  if (provider.type === "tavily") return "Tavily Search";
  return provider.connectionMode === "managed" ? "内置 SearXNG" : "自定义 SearXNG";
}
