import { Button } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { useWorkbenchNavigation } from "../layouts/workbench-shell";
import { SearchSelect } from "../ui/search-select";
import { Cron } from "croner";
import { AlertTriangle, CalendarClock, Check, ChevronsUpDown, Clock3, ListRestart, Pencil, Play, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { isDeletedSessionTarget, type ScheduledTaskSchedule } from "../../shared/scheduled-task-contracts";
import { api, type ScheduledTask, type ScheduledTaskRun, type SessionSummary } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { WorkspaceAgentNavigation, WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT } from "../components/workspace-agent-navigation";
import "../configuration.css";
import "../resources.css";
import "../scheduled-tasks.css";

const presets = [["每 5 分钟", "*/5 * * * *"], ["每小时", "0 * * * *"], ["工作日 9 点", "0 9 * * 1-5"], ["每天 9 点", "0 9 * * *"], ["每周一 9 点", "0 9 * * 1"], ["每月 1 日", "0 9 1 * *"]] as const;
const fields = [
  { label: "分钟", hint: "0–59", samples: ["*", "0", "*/5", "0,15,30,45"] },
  { label: "小时", hint: "0–23", samples: ["*", "9", "9-18", "*/2"] },
  { label: "日期", hint: "1–31", samples: ["*", "1", "1-5", "1,15"] },
  { label: "月份", hint: "1–12", samples: ["*", "1", "1-6", "1,4,7,10"] },
  { label: "星期", hint: "0–7", samples: ["*", "1", "1-5", "0,6"] },
] as const;

/** 将定时任务的目标、计划和状态错误保留在当前表单。 */
function scheduledTaskExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_SCHEDULED_TASK: show,
    SCHEDULED_TASK_NOT_FOUND: show,
    SCHEDULED_TASK_TARGET_MISSING: show,
    SCHEDULED_TASKS_BOUND: show,
    SESSION_NOT_FOUND: show,
    SESSION_BUSY: show,
    AGENT_NOT_FOUND: show,
    OPERATION_ABORTED: show,
  };
}

/** 管理指定 Agent 定时任务的工作台页面。 */
export function ScheduledTasksPage() {
  const { runApiTask } = useApiTask();
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [agentId, setAgentId] = useState("");
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [editing, setEditing] = useState<ScheduledTask | "new" | undefined>();
  const [runsTaskId, setRunsTaskId] = useState<string>();
  const [deleteCandidate, setDeleteCandidate] = useState<ScheduledTask>();
  const navigation = useWorkbenchNavigation();
  const [standaloneNavigationOpen, setStandaloneNavigationOpen] = useState(false);
  const mobileNavigationOpen = navigation ? navigation.drawer === "secondary" : standaloneNavigationOpen;
  const closeNavigation = () => navigation ? navigation.close() : setStandaloneNavigationOpen(false);
  const [error, setError] = useState("");
  const currentAgent = agents.find((agent) => agent.profile.id === agentId);

  const reload = async () => {
    if (!agentId) return;
    const result = await runApiTask(() => api.listScheduledTasks(agentId), { operation: "加载定时任务", expected: scheduledTaskExpected(setError) });
    if (result.status === "success") setTasks(result.data.tasks);
  };

  useEffect(() => {
    void runApiTask(api.listAgents, { operation: "加载定时任务 Agent" }).then((result) => {
      if (result.status !== "success") return;
      const nextAgents = result.data.agents;
      setAgents(nextAgents);
      setAgentId(nextAgents[0]?.profile.id ?? "");
    });
  }, [runApiTask]);
  useEffect(() => {
    void reload();
  }, [agentId, runApiTask]);
  useEffect(() => {
    const toggle = () => setStandaloneNavigationOpen((current) => !current);
    window.addEventListener(WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(WORKSPACE_AGENT_NAVIGATION_TOGGLE_EVENT, toggle);
  }, []);

  const runTask = async (task: ScheduledTask) => {
    const result = await runApiTask(() => api.runScheduledTask(task.id), { operation: "手动执行定时任务", expected: scheduledTaskExpected(setError) });
    if (result.status === "success") setRunsTaskId(task.id);
  };
  const removeTask = async () => {
    if (!deleteCandidate) return;
    const result = await runApiTask(() => api.deleteScheduledTask(deleteCandidate.id), { operation: "删除定时任务", expected: scheduledTaskExpected(setError) });
    if (result.status === "success") {
      setDeleteCandidate(undefined);
      await reload();
    }
  };

  return (
    <div className="workspace-resources-page scheduled-tasks-page">
      <WorkspaceAgentNavigation
        agents={agents}
        selectedAgentId={agentId}
        mobileOpen={mobileNavigationOpen}
        eyebrow="AGENTS"
        title="定时任务 Agent"
        navigationLabel="定时任务 Agent 列表"
        onSelect={(nextAgentId) => {
          setAgentId(nextAgentId);
          closeNavigation();
        }}
        onClose={closeNavigation}
      />
      <section className="workspace-resources-page__main">
        <header className="workspace-resources-page__heading scheduled-tasks-page__heading">
          <div>
            <span>SCHEDULED TASKS</span>
            <h1>定时任务</h1>
            <p>{currentAgent ? `管理 ${currentAgent.profile.name} 的自动执行任务。` : "选择一个 Agent 以管理其自动执行任务。"}</p>
          </div>
          <Button variant="primary" type="button" className="configuration-primary-action" onClick={() => setEditing("new")} disabled={!agentId}>
            <Plus size={16} aria-hidden="true" />新建任务
          </Button>
        </header>

        {error ? <p className="configuration-inline-error">{error}</p> : null}
        {editing ? <TaskForm agentId={agentId} task={editing === "new" ? undefined : editing} onClose={() => setEditing(undefined)} onSaved={() => { setEditing(undefined); void reload(); }} /> : null}
        {deleteCandidate ? (
          <section className="scheduled-task-confirm" aria-label="删除定时任务确认">
            <div>
              <span>DELETE TASK</span>
              <p>删除“{deleteCandidate.name}”及其执行记录？此操作不可恢复。</p>
            </div>
            <footer>
              <button type="button" onClick={() => setDeleteCandidate(undefined)}>取消</button>
              <button type="button" className="is-danger" onClick={() => void removeTask()}>删除任务</button>
            </footer>
          </section>
        ) : null}

        <section className="scheduled-task-list-section" aria-label="定时任务列表">
          <header>
            <div>
              <span>ACTIVE CONFIGURATION</span>
              <h2>任务列表</h2>
            </div>
            <small>{tasks.length} 个任务</small>
          </header>
          <div className="scheduled-tasks-list">
            {tasks.map((task) => <TaskCard key={task.id} task={task} onRun={() => void runTask(task)} onEdit={() => setEditing(task)} onDelete={() => setDeleteCandidate(task)} onRuns={() => setRunsTaskId((current) => current === task.id ? undefined : task.id)} />)}
            {!tasks.length ? <p className="scheduled-task-empty">当前 Agent 暂无定时任务。</p> : null}
          </div>
        </section>
        {runsTaskId ? <TaskRuns taskId={runsTaskId} /> : null}
      </section>
    </div>
  );
}

/** 展示单个任务及其快捷操作。 */
function TaskCard({ task, onRun, onEdit, onDelete, onRuns }: { task: ScheduledTask; onRun(): void; onEdit(): void; onDelete(): void; onRuns(): void }) {
  const deletedTarget = isDeletedSessionTarget(task.target) ? task.target : undefined;
  const targetMissing = Boolean(deletedTarget);

  return (
    <article className={`scheduled-task-card${targetMissing ? " is-target-missing" : ""}`} style={targetMissing ? { background: "color-mix(in srgb, var(--danger) 5%, var(--panel))", boxShadow: "3px 0 0 var(--danger) inset" } : undefined}>
      <div className="scheduled-task-card__icon"><CalendarClock size={17} aria-hidden="true" /></div>
      <div className="scheduled-task-card__body">
        <strong>{task.name}</strong>
        <small>{describeSchedule(task)}</small>
        {deletedTarget ? (
          <div className="scheduled-task-target-missing" style={{ display: "flex", gap: 7, color: "var(--danger)" }} role="alert">
            <AlertTriangle size={16} aria-hidden="true" />
            <span style={{ display: "grid" }}>
              <strong style={{ color: "var(--danger)", whiteSpace: "normal" }}>原目标会话“{deletedTarget.sessionName}”已删除</strong>
              <small style={{ color: "var(--danger)", whiteSpace: "normal" }}>任务已停用，请编辑并重新选择目标。</small>
            </span>
          </div>
        ) : (
          <small>{task.target.type === "new_session" ? "每次新建会话" : "执行到现有会话"} · {task.nextRunAt ? `下次：${formatDate(task.nextRunAt)}` : "已暂停"}</small>
        )}
      </div>
      <span className={!targetMissing && task.enabled ? "scheduled-task-state is-enabled" : "scheduled-task-state"}>{targetMissing ? "需重新指定目标" : task.enabled ? "已启用" : "已暂停"}</span>
      <div className="scheduled-task-card__actions">
        <button type="button" className="scheduled-task-card__run" onClick={onRun} disabled={targetMissing} title={targetMissing ? "请先重新指定目标会话" : undefined}><Play size={14} aria-hidden="true" />立即执行</button>
        <button type="button" aria-label={`编辑 ${task.name}`} title="编辑任务" onClick={onEdit}><Pencil size={15} aria-hidden="true" /></button>
        <button type="button" aria-label={`查看 ${task.name} 执行记录`} title="执行记录" onClick={onRuns}><ListRestart size={15} aria-hidden="true" /></button>
        <button type="button" className="is-danger" aria-label={`删除 ${task.name}`} title="删除任务" onClick={onDelete}><Trash2 size={15} aria-hidden="true" /></button>
      </div>
    </article>
  );
}

/** 创建或编辑任务的表单。 */
function TaskForm({ agentId, task, onClose, onSaved }: { agentId: string; task?: ScheduledTask; onClose(): void; onSaved(): void }) {
  const { runApiTask } = useApiTask();
  const targetWasDeleted = task ? isDeletedSessionTarget(task.target) : false;
  const [name, setName] = useState(task?.name ?? "");
  const [prompt, setPrompt] = useState(task?.prompt ?? "");
  const [mode, setMode] = useState<"interval" | "cron" | "once">(task?.schedule.type ?? "cron");
  const [expression, setExpression] = useState(task?.schedule.type === "cron" ? task.schedule.expression : "0 9 * * *");
  const [timezone, setTimezone] = useState(task?.schedule.type === "cron" ? task.schedule.timezone : "");
  const [timezones, setTimezones] = useState<string[]>([]);
  const [interval, setInterval] = useState(task?.schedule.type === "interval" ? task.schedule.value : 1);
  const [onceAt, setOnceAt] = useState(task?.schedule.type === "once" ? task.schedule.runAt.slice(0, 16) : "");
  const [unit, setUnit] = useState<"minute" | "hour">(task?.schedule.type === "interval" ? task.schedule.unit : "hour");
  const [enabled, setEnabled] = useState(task?.enabled ?? true);
  const [targetMode, setTargetMode] = useState<"new_session" | "existing_session">(task?.target.type === "new_session" ? "new_session" : "existing_session");
  const [targetResolved, setTargetResolved] = useState(!targetWasDeleted);
  const [archiveAfterCompletion, setArchiveAfterCompletion] = useState(task?.target.type === "new_session" ? task.target.archiveAfterCompletion : false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [sessionId, setSessionId] = useState(task?.target.type === "existing_session" ? task.target.sessionId : "");
  const [error, setError] = useState("");

  useEffect(() => {
    void runApiTask(() => Promise.all([api.listSessions(agentId), api.getScheduledTaskTimezones()]), { operation: "加载定时任务表单", expected: scheduledTaskExpected(setError) }).then((result) => {
      if (result.status !== "success") return;
      const [sessionResult, timezoneResult] = result.data;
      setSessions(sessionResult.sessions);
      // 原目标已删除时保留空选择，避免在用户不知情时自动改投其他会话。
      setSessionId((current) => current || (targetWasDeleted ? "" : sessionResult.sessions[0]?.id) || "");
      setTimezones(timezoneResult.timezones);
      setTimezone((current) => current || timezoneResult.serverTimeZone);
    });
  }, [agentId, targetWasDeleted, runApiTask]);

  const parts = normalizeParts(expression);
  const previews = useMemo(() => {
    try {
      return new Cron(expression, { timezone, mode: "5-part" }).nextRuns(5).map((date) => new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short", timeZone: timezone }).format(date));
    } catch {
      return [];
    }
  }, [expression, timezone]);
  const setPart = (index: number, value: string) => {
    const next = normalizeParts(expression);
    next[index] = value || "*";
    setExpression(next.join(" "));
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!targetResolved) {
      setError("请重新选择任务目标");
      return;
    }
    if (targetMode === "existing_session" && !sessionId) {
      setError("请选择现有会话");
      return;
    }
    const schedule: ScheduledTaskSchedule = mode === "cron"
      ? { type: "cron", expression, timezone }
      : mode === "once"
        ? { type: "once", runAt: new Date(onceAt).toISOString() }
        : { type: "interval", unit, value: interval };
    const input = {
      name,
      prompt,
      enabled,
      schedule,
      target: targetMode === "new_session"
        ? { type: "new_session" as const, archiveAfterCompletion }
        : { type: "existing_session" as const, sessionId },
    };
    const result = await runApiTask(
      () => task ? api.updateScheduledTask(task.id, input) : api.createScheduledTask(agentId, input),
      { operation: "保存定时任务", expected: scheduledTaskExpected(setError) },
    );
    if (result.status === "success") onSaved();
  }

  return (
    <form className="scheduled-task-editor" onSubmit={save}>
      <header className="scheduled-task-editor__header">
        <div>
          <span>{task ? "EDIT TASK" : "NEW TASK"}</span>
          <h2>{task ? "编辑定时任务" : "新建定时任务"}</h2>
        </div>
        <label className="scheduled-task-switch">
          <Checkbox checked={enabled} disabled={!targetResolved} onChange={(event) => setEnabled(event.target.checked)} />
          <span aria-hidden="true" />
          启用任务
        </label>
      </header>

      <section className="scheduled-task-editor__section scheduled-task-editor__section--basics">
        <label className="scheduled-task-field">
          <span>任务名称</span>
          <input value={name} onChange={(event) => setName(event.target.value)} placeholder="例如：每日工作总结" required />
        </label>
        <label className="scheduled-task-field scheduled-task-field--wide">
          <span>执行提示词</span>
          <textarea value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="任务触发时发送给会话的提示词" required />
        </label>
      </section>

      <section className="scheduled-task-editor__section">
        <div className="scheduled-task-section-heading">
          <div><span>SCHEDULE</span><h3>执行方式</h3></div>
          <p>选择固定间隔、Cron 规则或单次执行。</p>
        </div>
        <div className="scheduled-task-segmented" role="radiogroup" aria-label="执行方式">
          <button type="button" role="radio" aria-checked={mode === "interval"} className={mode === "interval" ? "is-active" : undefined} onClick={() => setMode("interval")}>间隔执行</button>
          <button type="button" role="radio" aria-checked={mode === "cron"} className={mode === "cron" ? "is-active" : undefined} onClick={() => setMode("cron")}>Cron 表达式</button>
          <button type="button" role="radio" aria-checked={mode === "once"} className={mode === "once" ? "is-active" : undefined} onClick={() => setMode("once")}>指定时间一次</button>
        </div>

        {mode === "interval" ? (
          <div className="scheduled-task-interval">
            <label className="scheduled-task-field"><span>间隔数值</span><input type="number" min="1" value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></label>
            <label className="scheduled-task-field"><span>时间单位</span><SearchSelect
              ariaLabel="时间单位"
              value={unit}
              onChange={(next) => setUnit(next as typeof unit)}
              options={[
                { value: "minute", label: "分钟" },
                { value: "hour", label: "小时" },
              ]}
            /></label>
          </div>
        ) : null}
        {mode === "once" ? (
          <label className="scheduled-task-field scheduled-task-once">
            <span>执行时间</span>
            <input type="datetime-local" value={onceAt} onChange={(event) => setOnceAt(event.target.value)} required />
            <small>到达该时间点后只执行一次，并自动暂停任务。</small>
          </label>
        ) : null}
        {mode === "cron" ? <CronEditor expression={expression} fieldsValue={parts} previews={previews} timezone={timezone} timezones={timezones} onExpressionChange={setExpression} onPartChange={setPart} onTimezoneChange={setTimezone} /> : null}
      </section>

      <section className="scheduled-task-editor__section">
        <div className="scheduled-task-section-heading">
          <div><span>TARGET SESSION</span><h3>目标会话</h3></div>
          <p>可为每次任务创建独立会话，或向已有会话发送消息。</p>
        </div>
        {!targetResolved && task && isDeletedSessionTarget(task.target) ? (
          <div className="scheduled-task-target-missing scheduled-task-target-missing--editor" style={{ display: "flex", gap: 7, padding: 12, border: "1px solid var(--danger)", borderRadius: 9, color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 8%, var(--panel))" }} role="alert">
            <AlertTriangle size={18} aria-hidden="true" />
            <span style={{ display: "grid" }}>
              <strong>原目标会话“{task.target.sessionName}”已删除</strong>
              <small>任务已停用，重新选择目标后才能启用或保存。</small>
            </span>
          </div>
        ) : null}
        <div className="scheduled-task-segmented" role="radiogroup" aria-label="目标会话">
          <button type="button" role="radio" aria-checked={targetMode === "new_session"} className={targetMode === "new_session" ? "is-active" : undefined} onClick={() => { setTargetMode("new_session"); setTargetResolved(true); }}>每次新建会话</button>
          <button type="button" role="radio" aria-checked={targetMode === "existing_session"} className={targetMode === "existing_session" ? "is-active" : undefined} onClick={() => { setTargetMode("existing_session"); setTargetResolved(Boolean(sessionId)); }}>现有会话</button>
        </div>
        {targetMode === "new_session" ? (
          <label className="scheduled-task-check">
            <Checkbox checked={archiveAfterCompletion} onChange={(event) => setArchiveAfterCompletion(event.target.checked)} />
            <span>执行完成后自动归档</span>
          </label>
        ) : (
          <div className="scheduled-task-field scheduled-task-session-select">
            <span>选择会话</span>
            <SessionPicker sessions={sessions} value={sessionId} onChange={(nextSessionId) => { setSessionId(nextSessionId); setTargetResolved(true); }} />
          </div>
        )}
      </section>

      {error ? <p className="configuration-inline-error">{error}</p> : null}
      <footer className="scheduled-task-editor__actions">
        <button type="button" onClick={onClose}>取消</button>
        <Button variant="primary" className="configuration-primary-action" type="submit">保存任务</Button>
      </footer>
    </form>
  );
}

/** 使用应用内列表框选择定时任务应投递的既有会话。 */
function SessionPicker({ sessions, value, onChange }: { sessions: SessionSummary[]; value: string; onChange(value: string): void }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const selectedSession = sessions.find((session) => session.id === value);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  return (
    <div className="scheduled-task-session-picker" ref={rootRef}>
      <button
        type="button"
        className="scheduled-task-session-picker__trigger"
        aria-label="选择现有会话"
        aria-expanded={open}
        aria-haspopup="listbox"
        disabled={!sessions.length}
        onClick={() => setOpen((current) => !current)}
      >
        <span>{selectedSession ? sessionTitle(selectedSession) : "暂无可用会话"}</span>
        <ChevronsUpDown size={15} aria-hidden="true" />
      </button>
      {open ? (
        <div className="scheduled-task-session-picker__popover" role="listbox" aria-label="可用会话" onKeyDown={(event) => {
          if (event.key === "Escape") setOpen(false);
        }}>
          {sessions.map((session) => (
            <button
              key={session.id}
              type="button"
              role="option"
              aria-selected={session.id === value}
              onClick={() => {
                onChange(session.id);
                setOpen(false);
              }}
            >
              <span><strong>{sessionTitle(session)}</strong><small>{session.id}</small></span>
              {session.id === value ? <Check size={16} aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** 提供 Cron 原始表达式、字段化编辑、快捷规则与未来执行预览。 */
function CronEditor({ expression, fieldsValue, previews, timezone, timezones, onExpressionChange, onPartChange, onTimezoneChange }: {
  expression: string;
  fieldsValue: string[];
  previews: string[];
  timezone: string;
  timezones: string[];
  onExpressionChange(value: string): void;
  onPartChange(index: number, value: string): void;
  onTimezoneChange(value: string): void;
}) {
  return (
    <div className="scheduled-task-cron-editor">
      <div className="scheduled-task-cron-presets" aria-label="Cron 快捷规则">
        {presets.map(([label, value]) => <button key={value} type="button" onClick={() => onExpressionChange(value)}>{label}</button>)}
      </div>
      <label className="scheduled-task-field">
        <span>原始 Cron 表达式</span>
        <input value={expression} onChange={(event) => onExpressionChange(event.target.value)} aria-label="原始 Cron 表达式" />
        <small>支持通配符、单值、范围、步进与列表；字段修改会同步到此表达式。</small>
      </label>
      <div className="scheduled-task-cron-fields">
        {fields.map((field, index) => <CronFieldEditor key={field.label} field={field} value={fieldsValue[index]} onChange={(value) => onPartChange(index, value)} />)}
      </div>
      <label className="scheduled-task-field scheduled-task-timezone">
        <span>时区</span>
        <input list="timezone-options" value={timezone} onChange={(event) => onTimezoneChange(event.target.value)} required />
        <datalist id="timezone-options">{timezones.map((zone) => <option key={zone} value={zone} />)}</datalist>
      </label>
      <section className="scheduled-task-cron-preview" aria-label="未来 5 次执行预览">
        <header><span>NEXT RUNS</span><strong>下 5 次执行预览</strong></header>
        {previews.length ? <ol>{previews.map((value, index) => <li key={`${value}-${index}`}><span>{String(index + 1).padStart(2, "0")}</span>{value}</li>)}</ol> : <p>当前 Cron 表达式或时区无效。</p>}
      </section>
    </div>
  );
}

/** Cron 单字段编辑器，提供五类常用表达式入口。 */
function CronFieldEditor({ field, value, onChange }: { field: typeof fields[number]; value: string; onChange(value: string): void }) {
  const mode = value === "*" ? "每个" : value.startsWith("*/") ? "步进" : value.includes(",") ? "列表" : value.includes("-") ? "范围" : "单值";
  const applyMode = (nextMode: string) => onChange(nextMode === "每个" ? "*" : nextMode === "步进" ? "*/1" : nextMode === "范围" ? "0-1" : nextMode === "列表" ? "0,1" : "0");
  return <label className="scheduled-task-cron-field"><span>{field.label}</span><SearchSelect
    ariaLabel={`${field.label} 模式`}
    value={mode}
    onChange={(next) => applyMode(next)}
    options={[
      { value: "每个", label: "每个" },
      { value: "单值", label: "单值" },
      { value: "范围", label: "范围" },
      { value: "步进", label: "步进" },
      { value: "列表", label: "列表" },
    ]}
  /><input value={value} placeholder={field.samples.join(" / ")} onChange={(event) => onChange(event.target.value)} /><small>{field.hint}</small></label>;
}

/** 加载并显示任务的最近执行记录。 */
function TaskRuns({ taskId }: { taskId: string }) {
  const { runApiTask } = useApiTask();
  const [runs, setRuns] = useState<ScheduledTaskRun[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    void runApiTask(() => api.listScheduledTaskRuns(taskId), { operation: "加载定时任务执行记录", expected: scheduledTaskExpected(setError) })
      .then((result) => { if (active && result.status === "success") setRuns(result.data.runs); });
    return () => { active = false; };
  }, [taskId, runApiTask]);
  return <section className="scheduled-task-runs"><header><div><span>RUN HISTORY</span><h2><Clock3 size={17} aria-hidden="true" />执行记录</h2></div></header>{error ? <p className="configuration-inline-error" role="alert">{error}</p> : runs.length ? <ol>{runs.map((run) => <li key={run.id}><strong data-status={run.status}>{run.status}</strong><span>{run.trigger === "manual" ? "手动" : "定时"} · {formatDate(run.startedAt)}{run.reason ? ` · ${run.reason}` : ""}</span></li>)}</ol> : <p className="scheduled-task-empty">尚无执行记录。</p>}</section>;
}

/** 将 Cron 原始表达式归一化为五个字段。 */
function normalizeParts(expression: string): string[] {
  return [...expression.trim().split(/\s+/u), "*", "*", "*", "*", "*"].slice(0, 5);
}

/** 返回会话在选择器中展示的简短名称。 */
function sessionTitle(session: SessionSummary): string {
  return session.name || session.firstMessage || session.id;
}

/** 生成任务卡片内使用的摘要文字。 */
function describeSchedule(task: ScheduledTask): string {
  return task.schedule.type === "cron"
    ? `${task.schedule.expression} · ${task.schedule.timezone}`
    : task.schedule.type === "once"
      ? `一次：${formatDate(task.schedule.runAt)}`
      : `每 ${task.schedule.value} ${task.schedule.unit === "minute" ? "分钟" : "小时"}`;
}

/** 用浏览器当前语言格式化记录时间。 */
function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
