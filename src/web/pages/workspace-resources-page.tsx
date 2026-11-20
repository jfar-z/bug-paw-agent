import { useWorkbenchNavigation } from "../layouts/workbench-shell";
import { useEffect, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { WorkspaceAgentNavigation, WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT } from "../components/workspace-agent-navigation";
import { WorkspaceBrowser } from "../components/workspace-browser";
import "../configuration.css";
import "../resources.css";

/** 管理所有 Agent 的工作目录，并将文件操作交给复用资源浏览器。 */
export function WorkspaceResourcesPage() {
  const { runApiTask } = useApiTask();
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [agentId, setAgentId] = useState("");
  const navigation = useWorkbenchNavigation();
  const [standaloneNavigationOpen, setStandaloneNavigationOpen] = useState(false);
  const mobileNavigationOpen = navigation ? navigation.drawer === "secondary" : standaloneNavigationOpen;
  const closeNavigation = () => navigation ? navigation.close() : setStandaloneNavigationOpen(false);

  useEffect(() => {
    void runApiTask(api.listAgents, { operation: "加载工作区 Agent" }).then((result) => {
      if (result.status !== "success") return;
      setAgents(result.data.agents);
      setAgentId((current) => current || result.data.agents[0]?.profile.id || "");
    });
  }, [runApiTask]);
  useEffect(() => {
    const toggle = () => setStandaloneNavigationOpen((current) => !current);
    window.addEventListener(WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT, toggle);
  }, []);

  const selectAgent = (nextAgentId: string) => {
    setAgentId(nextAgentId);
    closeNavigation();
  };
  const currentAgent = agents.find((agent) => agent.profile.id === agentId);
  const heading = <>
    <header className="workspace-resources-page__heading"><div><span>WORKSPACE · FILES</span><h1>资源管理</h1><p>{currentAgent ? `${currentAgent.profile.name} 的工作目录` : "正在加载 Agent 工作目录…"}</p></div></header>
    {!agents.length ? <section className="workspace-resources-page__empty-state"><img src="/brand/bugpaw/bugpaw-sleeping.png" alt="BUG 正在等候第一个工作空间" /><div><strong>BUG 还没有第一个工作空间</strong><p>请先在配置中心创建 Agent。</p></div></section> : null}
  </>;

  return <div className="workspace-resources-page">
    <WorkspaceAgentNavigation agents={agents} selectedAgentId={agentId} mobileOpen={mobileNavigationOpen} onSelect={selectAgent} onClose={closeNavigation} />
    <WorkspaceBrowser agentId={agentId} mode="page" heading={heading} />
  </div>;
}
