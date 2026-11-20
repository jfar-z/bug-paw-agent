import {
  ShieldCheck,
  Activity,
  Bot,
  BrainCircuit,
  type LucideIcon,
  Boxes,
  Cable,
  Globe2,
  Volume2,
  History,
  KeyRound,
  LayoutDashboard,
  MonitorPlay,
  SlidersHorizontal,
  X,
} from "lucide-react";
import { SecondarySidebarHeader } from "../ui/sidebar-header";
import { Fragment } from "react";
import { configurationGroups } from "../configuration-navigation";
import type { AppRoute } from "../router";

interface ConfigurationSidebarProps {
  route: AppRoute;
  open: boolean;
  onClose: () => void;
  onNavigate: (route: AppRoute) => boolean | void;
}

/**
 * 展示配置中心二级目录；尚未接入的模块明确标记为后续阶段。
 */
export function ConfigurationSidebar({ route, open, onClose, onNavigate }: ConfigurationSidebarProps) {
  const go = (nextRoute: AppRoute) => {
    if (onNavigate(nextRoute) !== false) onClose();
  };
  const agentActive = route.page === "agents" || route.page === "agent-detail";

  return (
    <aside className={open ? "configuration-sidebar is-open" : "configuration-sidebar"}>
      <SecondarySidebarHeader
        className="configuration-sidebar__header"
        eyebrow="SETTINGS"
        title="配置中心"
        actions={<button type="button" className="icon-button configuration-sidebar__close" aria-label="关闭配置导航" onClick={onClose}>
          <X size={18} aria-hidden="true" />
        </button>}
      />

      <nav className="configuration-nav" aria-label="配置中心导航">
        <p>工作区</p>
        <button type="button" className={route.page === "configuration-overview" ? "is-active" : undefined} aria-current={route.page === "configuration-overview" ? "page" : undefined} onClick={() => go({ page: "configuration-overview" })}><LayoutDashboard size={17} aria-hidden="true" /><span>概览</span></button>
        {configurationGroups.map((group, index) => <Fragment key={group.title}>
          {index > 0 ? <p>{group.title}</p> : null}
          {group.entries.map((entry) => {
            const Icon = icons[entry.key];
            const active = entry.key === "agents" ? agentActive : route.page === entry.route.page;
            return <button key={entry.key} type="button" className={active ? "is-active" : undefined} aria-current={active ? "page" : undefined} onClick={() => go(entry.route)}><Icon size={17} aria-hidden="true" /><span>{entry.title}</span></button>;
          })}
        </Fragment>)}
      </nav>

    </aside>
  );
}

/** 图标沿用既有配置侧栏体系，入口顺序由共享元数据决定。 */
const icons: Record<string, LucideIcon> = { security: ShieldCheck, "pi-settings": SlidersHorizontal, resources: Boxes, providers: KeyRound, agents: Bot, "web-research": Globe2, "browser-automation": MonitorPlay, "aigc-channels": Cable, tts: Volume2, "knowledge-retrieval": BrainCircuit, "configuration-operations": History, diagnostics: Activity };
