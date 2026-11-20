import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { SearchSelect } from "../ui/search-select";
import { AgentAvatar } from "./agent-avatar";

interface AgentModelMenuProps {
  agents?: AgentProfileDocument[];
  agent?: { id: string; name: string; avatarText: string };
  selectedAgentId?: string;
  disabled?: boolean;
  onSelectAgent?: (agentId: string) => void;
}

/** 会话头部用公共选择器切换 Agent，保留头像和工作目录。 */
export function AgentModelMenu({ agents = [], agent, selectedAgentId, disabled, onSelectAgent }: AgentModelMenuProps) {
  return <SearchSelect
    ariaLabel="切换 Agent"
    className="agent-model-menu"
    options={agents.map((item) => ({
      value: item.profile.id,
      label: item.profile.name,
      description: item.profile.cwd,
      icon: <AgentAvatar agent={item} className="agent-model-menu__avatar" />,
    }))}
    value={selectedAgentId}
    placeholder={agent?.name ?? "选择 Agent"}
    placeholderIcon={<span className="agent-model-menu__avatar">{agent?.avatarText ?? "?"}</span>}
    disabled={disabled}
    searchable={false}
    onChange={onSelectAgent}
  />;
}
