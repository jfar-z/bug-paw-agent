import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { X } from "lucide-react";
import { IconButton } from "../ui/controls";
import { AgentAvatar } from "./agent-avatar";
import { SecondarySidebarHeader } from "../ui/sidebar-header";

export const WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT = "pi-agent:toggle-workspace-agent-navigation";

interface WorkspaceAgentNavigationProps {
  agents: AgentProfileDocument[];
  selectedAgentId?: string;
  mobileOpen: boolean;
  eyebrow?: string;
  title?: string;
  navigationLabel?: string;
  onSelect: (agentId: string) => void;
  onClose: () => void;
}

/**
 * 展示资源管理页面的 Agent 二级导航，并在移动端以抽屉形式呈现。
 */
export function WorkspaceAgentNavigation({
  agents,
  selectedAgentId,
  mobileOpen,
  eyebrow = "WORKSPACES",
  title = "Agent 工作空间",
  navigationLabel = "Agent 工作空间列表",
  onSelect,
  onClose,
}: WorkspaceAgentNavigationProps) {
  const content = (
    <>
      <SecondarySidebarHeader
        className="workspace-agent-navigation__header"
        eyebrow={eyebrow}
        title={title}
        actions={<IconButton className="workspace-agent-navigation__close" label="关闭 Agent 列表" onClick={onClose}><X /></IconButton>}
      />
      <nav aria-label={navigationLabel}>
        {agents.map((agent) => (
          <button
            type="button"
            key={agent.profile.id}
            className={agent.profile.id === selectedAgentId ? "is-active" : undefined}
            aria-current={agent.profile.id === selectedAgentId ? "page" : undefined}
            aria-label={`选择 Agent ${agent.profile.name}`}
            onClick={() => onSelect(agent.profile.id)}
          >
            <AgentAvatar agent={agent} label={`${agent.profile.name} 头像`} />
            <span><strong>{agent.profile.name}</strong><small>{agent.profile.id}</small></span>
          </button>
        ))}
      </nav>
    </>
  );
  return <>
    <aside className="workspace-agent-navigation">{content}</aside>
    {mobileOpen ? <><button type="button" className="workspace-agent-navigation__scrim" aria-label="关闭 Agent 列表抽屉" tabIndex={-1} onClick={onClose} /><aside className="workspace-agent-navigation is-mobile-open">{content}</aside></> : null}
  </>;
}
