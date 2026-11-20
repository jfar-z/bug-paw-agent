import { Button, TextField } from "../ui/controls";
import { ArrowUpRight, Folder, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import type { AgentProfile, AgentProfileDocument } from "../../shared/agent-contracts";
import { api } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import type { AppRoute } from "../router";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEffectNotice, recordConfigurationSave } from "../components/configuration/configuration-effect-notice";
import "../configuration.css";
import "../agents.css";

interface AgentsPageProps {
  onNavigate: (route: AppRoute) => void;
  openCreateOnEmpty?: boolean;
}

function modelLabel(agent: AgentProfile): string {
  return agent.defaultModel ? `${agent.defaultModel.provider} / ${agent.defaultModel.id}` : "沿用全局默认模型";
}

function avatarLabel(agent: AgentProfile): string {
  if (agent.avatar?.kind === "initial") return agent.avatar.value;
  return agent.name.trim().slice(0, 1).toUpperCase() || "A";
}

function avatarUrl(agent: AgentProfile): string | undefined {
  return agent.avatar?.kind === "image"
    ? `/api/v1/agents/${encodeURIComponent(agent.id)}/avatar?v=${encodeURIComponent(agent.avatar.revision)}`
    : undefined;
}

/**
 * 根据 Agent 名称生成易读的自定义工作目录建议，用户仍可按需修改。
 */
function suggestedDirectorySuffix(name: string): string {
  const segment = name.trim().replace(/[\\/]+/gu, "-").replace(/\s+/gu, "-");
  return `workspace/agents/${segment || "agent"}`;
}

/**
 * 展示真实 Agent 列表，并提供轻量的新建入口。
 */
export function AgentsPage({ onNavigate, openCreateOnEmpty = false }: AgentsPageProps) {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [createOpen, setCreateOpen] = useState(false);
  const [name, setName] = useState("");
  const [cwd, setCwd] = useState("");
  const [directoryMode, setDirectoryMode] = useState<"automatic" | "custom">("automatic");
  const [directoryFollowsName, setDirectoryFollowsName] = useState(true);
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [draggingId, setDraggingId] = useState<string>();

  useEffect(() => {
    let active = true;
    void runApiTask(api.listAgents, { operation: "加载 Agent 列表" })
      .then((result) => {
        if (result.status !== "success") return;
        const loaded = result.data.agents;
        if (active) {
          setAgents(loaded);
          setCreateOpen(openCreateOnEmpty && loaded.length === 0);
        }
      });
    return () => { active = false; };
  }, [openCreateOnEmpty, runApiTask]);

  function resetCreateForm() {
    setName("");
    setCwd("");
    setDirectoryMode("automatic");
    setDirectoryFollowsName(true);
    setCreateOpen(false);
  }

  /**
   * 自定义目录仍使用系统建议值时，随 Agent 名称同步最后一级目录。
   */
  function updateName(nextName: string) {
    setName(nextName);
    if (directoryMode === "custom" && directoryFollowsName) {
      setCwd(suggestedDirectorySuffix(nextName));
    }
  }

  /**
   * 启用自定义目录时生成建议路径，已有用户输入则保持不变。
   */
  function enableCustomDirectory() {
    setDirectoryMode("custom");
    if (!cwd) {
      setCwd(suggestedDirectorySuffix(name));
      setDirectoryFollowsName(true);
    }
  }

  async function createAgent(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedName = name.trim();
    const normalizedCwd = cwd.trim().replace(/^\/+|\\+/gu, "");
    if (!normalizedName) return;
    if (directoryMode === "custom" && !normalizedCwd) {
      setError("请输入 /data/ 下的工作目录。");
      return;
    }
    setSubmitting(true);
    setError("");
    try {
      const result = await runApiTask(
        () => api.createAgent({ name: normalizedName, ...(directoryMode === "custom" ? { cwd: `/data/${normalizedCwd}` } : {}) }),
        { operation: "创建 Agent", expected: agentExpected(setError) },
      );
      if (result.status === "success") {
        recordConfigurationSave("agents");
        setAgents((current) => [...current, result.data]);
        resetCreateForm();
      }
    } finally {
      setSubmitting(false);
    }
  }

  /**
   * 将拖动的 Agent 插入目标位置，并把完整顺序提交到服务端。
   */
  async function moveAgent(targetId: string) {
    if (!draggingId || draggingId === targetId) return;
    const current = agents;
    const sourceIndex = current.findIndex(({ profile }) => profile.id === draggingId);
    const targetIndex = current.findIndex(({ profile }) => profile.id === targetId);
    if (sourceIndex < 0 || targetIndex < 0) return;
    const next = [...current];
    const [moving] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, moving);
    setAgents(next);
    setDraggingId(undefined);
    setError("");
    const result = await runApiTask(
      () => api.reorderAgents(next.map(({ profile }) => profile.id)),
      { operation: "保存 Agent 排序", expected: agentExpected(setError) },
    );
    if (result.status === "success") setAgents(result.data.agents);
    else setAgents(current);
  }

  return (
    <div className="configuration-page agents-page">
      <header className="configuration-page__heading configuration-page__heading--actions">
        <div>
          <span className="configuration-eyebrow">AGENT PROFILES</span>
          <h1>Agents</h1>
          <p>每个 Agent 拥有独立工作目录、运行配置与会话归属。</p>

        </div>
        <Button variant="primary" type="button" className="configuration-primary-action" onClick={() => setCreateOpen(true)} disabled={!online}>
          <Plus size={17} aria-hidden="true" />新建 Agent
        </Button>
      </header>

      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}

      {createOpen ? (
        <form className="configuration-create-panel" onSubmit={createAgent}>
          {openCreateOnEmpty && agents.length === 0 ? <p className="configuration-help configuration-create-panel__onboarding">请先创建 Agent 后再开始对话。</p> : null}
          <div className="configuration-create-panel__fields">
            <div>
              <label htmlFor="new-agent-name">Agent 名称</label>
              <TextField id="new-agent-name" autoFocus value={name} onChange={(event) => updateName(event.target.value)} maxLength={80} />
            </div>
            <fieldset className="agent-directory-field">
              <legend>工作目录</legend>
              <div className="agent-directory-field__mode" aria-label="工作目录方式">
                <button type="button" className={directoryMode === "automatic" ? "is-active" : undefined} aria-pressed={directoryMode === "automatic"} onClick={() => setDirectoryMode("automatic")}>自动分配</button>
                <button type="button" className={directoryMode === "custom" ? "is-active" : undefined} aria-pressed={directoryMode === "custom"} onClick={enableCustomDirectory}>使用自定义目录</button>
              </div>
              {directoryMode === "automatic" ? <p>系统将创建独立目录：<code>/data/workspace/agents/&lt;自动生成的 Agent ID&gt;</code></p> : <div className="agent-directory-field__input"><span aria-hidden="true">/data/</span><TextField id="new-agent-cwd" aria-label="工作目录" value={cwd} onChange={(event) => { setCwd(event.target.value); setDirectoryFollowsName(false); }} placeholder="例如 projects/research" /></div>}
              <small>{directoryMode === "automatic" ? "无需填写，系统会使用不会与其他 Agent 冲突的目录。" : "只需填写 /data/ 后的路径；目录不存在时自动创建。"}</small>
            </fieldset>
          </div>
          <Button variant="primary" type="submit" className="configuration-primary-action" disabled={submitting || !name.trim() || !online}>
            {submitting ? "创建中…" : "创建 Agent"}
          </Button>
          <button type="button" className="configuration-icon-action" aria-label="关闭新建表单" onClick={resetCreateForm}>
            <X size={17} aria-hidden="true" />
          </button>
        </form>
      ) : null}

      <ConfigurationEffectNotice configKey="agents" />
      <section className="agent-list" aria-label="Agent 列表">
        {agents.map(({ profile: agent }) => (
          <button
            type="button"
            className="agent-card"
            aria-label={`打开${agent.name}；可拖动排序`}
            key={agent.id}
            draggable
            onDragStart={() => setDraggingId(agent.id)}
            onDragEnd={() => setDraggingId(undefined)}
            onDragOver={(event) => event.preventDefault()}
            onDrop={() => void moveAgent(agent.id)}
            onClick={() => onNavigate({ page: "agent-detail", agentId: agent.id })}
          >
            <span className="agent-card__avatar" aria-hidden="true">
              {avatarUrl(agent) ? <img src={avatarUrl(agent)} alt="" /> : avatarLabel(agent)}
            </span>
            <span className="agent-card__body">
              <span className="agent-card__title"><strong>{agent.name}</strong><small><i />{agent.status === "active" ? "可用" : "已归档"}</small></span>
              <span className="agent-card__description">{agent.description || "尚未填写简介"}</span>
              <span className="agent-card__metadata">
                <span><Folder size={14} aria-hidden="true" /><code>{agent.cwd}</code></span>
                <span>{modelLabel(agent)}</span>
              </span>
            </span>
            <ArrowUpRight className="agent-card__arrow" size={18} aria-hidden="true" />
          </button>
        ))}
      </section>

      {agents.length === 0 ? (
        <div className="configuration-empty-note">
          <span>+</span>
          <p><strong>还没有 Agent</strong><small>创建一个 Agent 开始配置。</small></p>
        </div>
      ) : null}
    </div>
  );
}

/** 将 Agent 编辑和工作目录校验错误保留在当前表单。 */
function agentExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    AGENT_INVALID: show,
    AGENT_NOT_FOUND: show,
    AGENT_ARCHIVED: show,
    INVALID_AGENT_NAME: show,
    INVALID_AGENT_ORDER: show,
    VERSION_CONFLICT: show,
    AGENT_HAS_SESSIONS: show,
    AGENT_REMOVAL_IN_PROGRESS: show,
    DELETE_OPTIONS_REQUIRED: show,
    WORKSPACE_IN_USE: show,
    WORKSPACE_OUTSIDE_DATA: show,
    WORKSPACE_PI_CONFLICT: show,
    WORKSPACE_NOT_ABSOLUTE: show,
    WORKSPACE_ROOT_FORBIDDEN: show,
    WORKSPACE_NOT_DIRECTORY: show,
  };
}
