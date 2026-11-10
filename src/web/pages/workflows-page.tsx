import { workflowDraftFieldError } from "../features/workflows/workflow-field-guards";
import type { WorkflowSummary } from "../../shared/workflow-contracts";
import { WorkflowCopyDialog } from "../features/workflows/workflow-copy-dialog";
import { WorkflowValueView } from "../features/workflows/workflow-value-view";
import { workflowClientId } from "../features/workflows/workflow-id";
import { useErrorToast } from "../error-toast-provider";
import {
  WorkflowConfirmProvider,
  useWorkflowConfirm,
} from "../features/workflows/workflow-confirm";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  Plus,
  Play,
  Save,
  Check,
  ArrowLeft,
  Workflow,
  Search,
  Trash2,
  Pencil,
  Copy,
  Square,
  RefreshCw,
} from "lucide-react";
import {
  emptyWorkflow,
  workflowRunNodesInOrder,
  WORKFLOW_NODE_NAMES,
  type WorkflowDefinition,
  type WorkflowDraft,
  type WorkflowRun,
  type WorkflowCatalog,
  type WorkflowFile,
  type WorkflowStatus,
} from "../../shared/workflow-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import {
  navigateTo,
  NAVIGATION_BEFORE_EVENT,
  type AppRoute,
  type NavigationBeforeEvent,
} from "../router";
import { useOnlineStatus } from "../use-online-status";
import { WorkflowCanvas } from "../features/workflows/workflow-canvas";
import {
  WorkflowSelectedFiles,
  WorkflowValue,
} from "../features/workflows/workflow-fields";
import "../workflows.css";

type WorkflowRoute = Extract<
  AppRoute,
  {
    page: "workflows" | "workflow-editor" | "workflow-run" | "workflow-history";
  }
>;
const statusNames: Record<WorkflowStatus, string> = {
  prepared: "待运行",
  queued: "等待中",
  running: "运行中",
  succeeded: "已完成",
  failed: "失败",
  cancelled: "已取消",
  skipped: "已跳过",
};
const active = (run?: WorkflowRun) =>
  !!run && ["queued", "running"].includes(run.status);
/** 页面只在工作流路由加载，样式与画布依赖不进入聊天首屏。 */
export function WorkflowsPage({ route }: { route: WorkflowRoute }) {
  return (
    <WorkflowConfirmProvider>
      <main className="wf-page">
        {route.page === "workflow-editor" ? (
          <Editor key={route.workflowId} id={route.workflowId} />
        ) : route.page === "workflow-run" ? (
          <Runner
            key={route.workflowId ?? "runner"}
            workflowId={route.workflowId}
            runId={route.runId}
          />
        ) : route.page === "workflow-history" ? (
          <History />
        ) : (
          <WorkflowList />
        )}
      </main>
    </WorkflowConfirmProvider>
  );
}
/** 管理列表提供明确的空态、搜索和发布范围。 */
function WorkflowList() {
  const [copying, setCopying] = useState<WorkflowSummary>();
  const confirm = useWorkflowConfirm();
  const { runApiTask } = useApiTask(),
    online = useOnlineStatus();
  const [items, setItems] = useState<WorkflowSummary[]>([]),
    [query, setQuery] = useState(""),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const result = await runApiTask(api.listWorkflows, {
      operation: "读取工作流列表",
    });
    if (result.status === "success") setItems(result.data.workflows);
    setLoading(false);
  }, [runApiTask]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <>
      <header className="wf-page-heading">
        <div>
          <span className="wf-eyebrow">WORKFLOWS</span>
          <h1>工作流</h1>
          <p>将模型、Agent 与创作工具连接成可复用的流程。</p>
        </div>
        <button
          className="wf-button wf-primary"
          disabled={!online}
          onClick={() =>
            navigateTo({ page: "workflow-editor", workflowId: "new" })
          }
        >
          <Plus size={17} />
          新建工作流
        </button>
      </header>
      <div className="wf-list-toolbar">
        <label className="wf-search">
          <Search size={17} />
          <input
            aria-label="搜索工作流"
            placeholder="搜索名称或说明"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        <span>{items.length} 个工作流</span>
        <button
          className="icon-button"
          aria-label="刷新列表"
          disabled={loading || !online}
          onClick={() => void reload()}
        >
          <RefreshCw size={17} />
        </button>
      </div>
      {loading ? (
        <p role="status" className="wf-empty">
          正在读取工作流…
        </p>
      ) : !items.length ? (
        <div className="wf-empty">
          <Workflow size={34} />
          <h2>从一个输入开始</h2>
          <p>定义参数，连接节点，然后运行并查看每一步的结果。</p>
          <button
            className="wf-button"
            disabled={!online}
            onClick={() =>
              navigateTo({ page: "workflow-editor", workflowId: "new" })
            }
          >
            创建第一个工作流
          </button>
        </div>
      ) : (
        <div className="wf-workflow-list">
          {items
            .filter((w) =>
              `${w.name} ${w.description}`
                .toLowerCase()
                .includes(query.toLowerCase()),
            )
            .map((w) => (
              <article className="wf-list-item" key={w.id}>
                <div className="wf-list-icon">
                  <Workflow size={23} />
                </div>
                <div className="wf-list-copy">
                  <h2>
                    <button
                      className="wf-title-link"
                      onClick={() =>
                        navigateTo({
                          page: "workflow-editor",
                          workflowId: w.id,
                        })
                      }
                    >
                      {w.name}
                    </button>
                  </h2>
                  <p>{w.description || "暂无说明"}</p>
                  <small>
                    {w.nodeCount} 个节点 · v{w.revision} ·{" "}
                    {w.published ? "已开放给 Agent" : "仅手动运行"} ·{" "}
                    {new Date(w.updatedAt).toLocaleString()}
                  </small>
                </div>
                <div className="wf-actions">
                  <button
                    className="wf-button"
                    onClick={() =>
                      navigateTo({ page: "workflow-run", workflowId: w.id })
                    }
                  >
                    <Play size={15} />
                    运行
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`编辑 ${w.name}`}
                    onClick={() =>
                      navigateTo({ page: "workflow-editor", workflowId: w.id })
                    }
                  >
                    <Pencil size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`复制 ${w.name}`}
                    title="复制工作流"
                    disabled={!online}
                    onClick={() => setCopying(w)}
                  >
                    <Copy size={16} />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`删除 ${w.name}`}
                    disabled={!online}
                    onClick={async () => {
                      if (
                        await confirm(`删除工作流“${w.name}”？运行历史将保留。`)
                      )
                        void runApiTask(
                          () => api.deleteWorkflow(w.id, w.revision),
                          { operation: "删除工作流" },
                        ).then((r) => {
                          if (r.status === "success") void reload();
                        });
                    }}
                  >
                    <Trash2 size={16} />
                  </button>
                </div>
              </article>
            ))}
        </div>
      )}
      {copying && (
        <WorkflowCopyDialog
          workflow={copying}
          onClose={() => setCopying(undefined)}
          onCreated={(created) => {
            setCopying(undefined);
            navigateTo({ page: "workflow-editor", workflowId: created.id });
          }}
        />
      )}
    </>
  );
}
/** 编辑器维护保存快照，避免路由切换意外丢失未保存配置。 */
function Editor({ id }: { id: string }) {
  const confirm = useWorkflowConfirm();
  const { runApiTask } = useApiTask(),
    online = useOnlineStatus();
  const [draft, setDraft] = useState<WorkflowDraft>(emptyWorkflow),
    [saved, setSaved] = useState<WorkflowDefinition>(),
    [baseline, setBaseline] = useState(() => JSON.stringify(emptyWorkflow())),
    [catalog, setCatalog] = useState<WorkflowCatalog>({
      models: [],
      agents: [],
      interfaces: [],
    }),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [invalid, setInvalid] = useState<Record<string, boolean>>({}),
    [notice, setNotice] = useState("");
  // 应用主题或移动入口会更换任务回调，不能因此重新读取并覆盖当前草稿。
  const loadTask = useRef(runApiTask);
  loadTask.current = runApiTask;
  const skipGuard = useRef(false);
  const dirty = JSON.stringify(draft) !== baseline;
  const fieldError = workflowDraftFieldError(draft);
  const cannotSave =
    busy || !online || !!fieldError || Object.values(invalid).some(Boolean);
  useEffect(() => {
    let alive = true;
    void loadTask
      .current(
        async () => ({
          catalog: await api.getWorkflowCatalog(),
          definition: id === "new" ? undefined : await api.getWorkflow(id),
        }),
        { operation: "读取工作流编辑器" },
      )
      .then((r) => {
        if (!alive) return;
        if (r.status === "success") {
          setCatalog(r.data.catalog);
          if (r.data.definition) {
            setDraft(r.data.definition);
            setSaved(r.data.definition);
            setBaseline(JSON.stringify(r.data.definition));
          }
          setReady(true);
        }
      });
    return () => {
      alive = false;
    };
  }, [id]);
  useEffect(() => {
    const guard = (event: Event) => {
      if (dirty && !skipGuard.current) {
        event.preventDefault();
        void confirm("工作流有未保存的修改，确定离开？").then((answer) => {
          if (answer) {
            skipGuard.current = true;
            (event as NavigationBeforeEvent).resume?.();
            queueMicrotask(() => {
              skipGuard.current = false;
            });
          }
        });
      }
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (dirty && !skipGuard.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener(NAVIGATION_BEFORE_EVENT, guard);
    window.addEventListener("beforeunload", unload);
    return () => {
      window.removeEventListener(NAVIGATION_BEFORE_EVENT, guard);
      window.removeEventListener("beforeunload", unload);
    };
  }, [dirty, confirm]);
  const validity = useCallback(
    (key: string, valid: boolean) =>
      setInvalid((old) => ({ ...old, [key]: !valid })),
    [],
  );
  const save = async (run = false) => {
    if (cannotSave) return;
    setBusy(true);
    setNotice("");
    const r = await runApiTask(
      () => api.saveWorkflow(draft, saved?.id, saved?.revision),
      { operation: "保存工作流" },
    );
    if (r.status === "success") {
      setSaved(r.data);
      setDraft(r.data);
      setBaseline(JSON.stringify(r.data));
      setNotice("已保存");
      skipGuard.current = true;
      if (run) navigateTo({ page: "workflow-run", workflowId: r.data.id });
      else if (id === "new")
        navigateTo({ page: "workflow-editor", workflowId: r.data.id }, true);
      queueMicrotask(() => {
        skipGuard.current = false;
      });
    }
    setBusy(false);
  };
  if (!ready)
    return (
      <div className="wf-empty" role="status">
        正在加载节点目录与工作流…
      </div>
    );
  return (
    <div className="wf-editor">
      <header className="wf-editor-header">
        <button
          className="icon-button"
          aria-label="返回工作流列表"
          onClick={() => navigateTo({ page: "workflows" })}
        >
          <ArrowLeft size={18} />
        </button>
        <div className="wf-editor-title">
          <label className="wf-field">
            工作流名称
            <input
              maxLength={100}
              aria-label="工作流名称"
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            />
          </label>
          <span>
            {dirty
              ? "有未保存修改"
              : saved
                ? `v${saved.revision} · 已保存`
                : "新建草稿"}
          </span>
        </div>
        <div className="wf-actions">
          <button
            className="wf-button"
            disabled={cannotSave}
            onClick={() => {
              setBusy(true);
              void runApiTask(() => api.validateWorkflow(draft, saved?.id), {
                operation: "校验工作流",
              }).then((r) => {
                if (r.status === "success") setNotice("校验通过");
                setBusy(false);
              });
            }}
          >
            <Check size={16} />
            校验
          </button>
          <button
            className="wf-button"
            disabled={cannotSave}
            onClick={() => void save()}
          >
            <Save size={16} />
            保存
          </button>
          <button
            className="wf-button wf-primary"
            disabled={cannotSave}
            onClick={() => void save(true)}
          >
            <Play size={16} />
            保存并运行
          </button>
        </div>
      </header>
      {fieldError && (
        <div className="wf-definition-bar wf-error" role="alert">
          {fieldError}
        </div>
      )}
      <div className="wf-definition-bar">
        <label className="wf-field wf-description">
          工作流说明
          <textarea
            rows={2}
            maxLength={4000}
            aria-label="工作流说明"
            placeholder="描述用途及参数含义，帮助你和 Agent 正确使用"
            value={draft.description}
            onChange={(e) =>
              setDraft({ ...draft, description: e.target.value })
            }
          />
        </label>
        <label className="wf-check">
          <input
            type="checkbox"
            checked={draft.published}
            onChange={(e) =>
              setDraft({ ...draft, published: e.target.checked })
            }
          />
          开放给 Agent
        </label>
        <span role="status">
          {!online ? "离线 · 恢复联网后可保存与运行" : notice}
        </span>
      </div>
      <WorkflowCanvas
        workflowId={saved?.id}
        draft={draft}
        catalog={catalog}
        onChange={(value) => {
          setDraft(value);
          setNotice("");
        }}
        onValidity={validity}
      />
    </div>
  );
}
/** 运行表单按声明类型输入，媒体上传后仅传递资产引用。 */
function Runner({
  workflowId,
  runId,
}: {
  workflowId?: string;
  runId?: string;
}) {
  const { runApiTask } = useApiTask(),
    online = useOnlineStatus();
  const [items, setItems] = useState<WorkflowSummary[]>([]),
    [definition, setDefinition] = useState<WorkflowDefinition>(),
    [inputs, setInputs] = useState<Record<string, unknown>>({}),
    [run, setRun] = useState<WorkflowRun>(),
    [busy, setBusy] = useState(false),
    [invalid, setInvalid] = useState<Record<string, boolean>>({}),
    [polling, setPolling] = useState(true);
  // 移动入口或主题重渲染不重新加载定义，避免覆盖已填写参数和上传引用。
  const loadTask = useRef(runApiTask);
  loadTask.current = runApiTask;
  const key = useRef(workflowClientId());
  const toast = useErrorToast(),
    reportedErrors = useRef(new Set<string>());
  useEffect(() => {
    if (
      run?.status === "failed" &&
      run.error &&
      !reportedErrors.current.has(run.id)
    ) {
      reportedErrors.current.add(run.id);
      toast.push({
        operation: "执行工作流",
        title: "工作流执行失败",
        summary: run.error.message,
        code: run.error.code,
        requestId: run.error.requestId,
        safeDetail: run.error.nodeId ? `节点：${run.error.nodeId}` : undefined,
      });
    }
  }, [run, toast]);
  useEffect(() => {
    let alive = true;
    void loadTask
      .current(api.listWorkflows, { operation: "读取可运行工作流" })
      .then((r) => {
        if (alive && r.status === "success") {
          setItems(r.data.workflows);
        }
      });
    // 列表只有摘要，定义单独读取并丢弃切换工作流后返回的过期响应。
    setDefinition(undefined);
    if (workflowId) {
      void loadTask
        .current(() => api.getWorkflow(workflowId), {
          operation: "读取工作流定义",
        })
        .then((r) => {
          if (alive && r.status === "success") setDefinition(r.data);
        });
    }
    return () => {
      alive = false;
    };
  }, [workflowId]);
  useEffect(() => {
    if (!definition) return;
    const fields =
      definition.nodes.find((n) => n.kind === "input")?.outputs ?? [];
    const initial: Record<string, unknown> = {};
    for (const field of fields) {
      const previous =
        run?.workflowId === definition.id ? run.inputs[field.name] : undefined;
      const value =
        previous !== undefined
          ? previous
          : field.defaultValue !== undefined
            ? field.defaultValue
            : field.multiple
              ? []
              : field.type === "boolean"
                ? false
                : field.type === "object"
                  ? {}
                  : undefined;
      if (value !== undefined) initial[field.name] = value;
    }
    setInputs(initial);
    key.current = workflowClientId();
    setInvalid({});
  }, [definition, run?.id]);
  useEffect(() => {
    if (!runId || !online || !polling) return;
    let alive = true,
      timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const r = await runApiTask(() => api.getWorkflowRun(runId), {
        operation: "读取工作流运行进度",
      });
      if (!alive) return;
      if (r.status === "success") {
        setRun(r.data);
        if (active(r.data)) timer = setTimeout(() => void poll(), 2000);
      } else setPolling(false);
    };
    void poll();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [runId, online, polling, runApiTask]);
  const change = (name: string, value: unknown) => {
    setInputs((old) => ({ ...old, [name]: value }));
    key.current = workflowClientId();
  };
  const start = async () => {
    if (!definition) return;
    setBusy(true);
    const r = await runApiTask(
      () => api.runWorkflow(definition.id, inputs, key.current),
      { operation: "运行工作流" },
    );
    if (r.status === "success") {
      setRun(r.data);
      setPolling(true);
      navigateTo(
        { page: "workflow-run", workflowId: definition.id, runId: r.data.id },
        true,
      );
      key.current = workflowClientId();
    }
    setBusy(false);
  };
  return (
    <>
      <header className="wf-page-heading">
        <div>
          <span className="wf-eyebrow">EXECUTION</span>
          <h1>运行工作流</h1>
          <p>填写本次输入，实时查看各节点状态与执行结果。</p>
        </div>
        {definition && (
          <button
            className="wf-button"
            onClick={() =>
              navigateTo({ page: "workflow-editor", workflowId: definition.id })
            }
          >
            <Pencil size={16} />
            编辑工作流
          </button>
        )}
      </header>
      <div className="wf-run-layout">
        <section className="wf-run-form">
          <h2>运行参数</h2>
          <label className="wf-field">
            工作流
            <select
              value={workflowId ?? ""}
              disabled={busy}
              onChange={(e) =>
                navigateTo({
                  page: "workflow-run",
                  workflowId: e.target.value || undefined,
                })
              }
            >
              <option value="">选择工作流</option>
              {items.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name} · v{w.revision}
                </option>
              ))}
            </select>
          </label>
          {definition && (
            <>
              <p className="wf-hint">
                {definition.description || "配置本次运行的输入参数。"}
              </p>
              {definition.nodes
                .find((n) => n.kind === "input")
                ?.outputs.map((f) => (
                  <div className="wf-run-field" key={f.name}>
                    <div className="wf-output-row">
                      <strong>
                        {f.name}
                        {f.required ? " *" : ""}
                      </strong>
                      <code>
                        {f.type}
                        {f.multiple ? "[]" : ""}
                      </code>
                    </div>
                    {f.description && (
                      <p className="wf-hint">{f.description}</p>
                    )}
                    {["image", "video", "audio", "file"].includes(f.type) ? (
                      <>
                        <input
                          aria-label={`上传 ${f.name}`}
                          type="file"
                          multiple={f.multiple}
                          disabled={busy || !online}
                          accept={f.type === "file" ? undefined : `${f.type}/*`}
                          onChange={(e) => {
                            const files = [...(e.target.files ?? [])];
                            e.target.value = "";
                            if (!files.length) return;
                            const existing =
                              f.multiple && Array.isArray(inputs[f.name])
                                ? (inputs[f.name] as WorkflowFile[])
                                : [];
                            setBusy(true);
                            void runApiTask(
                              async () => {
                                if (existing.length + files.length > 100)
                                  throw new Error(
                                    `参数 ${f.name} 最多上传 100 个文件`,
                                  );
                                return Promise.all(
                                  files.map((file) =>
                                    api.uploadWorkflowFile(file),
                                  ),
                                );
                              },
                              { operation: `上传 ${f.name}` },
                            ).then((r) => {
                              // 数组支持分批追加，单文件仍替换；失败时保留此前成功上传的值。
                              if (r.status === "success")
                                change(
                                  f.name,
                                  f.multiple
                                    ? [...existing, ...r.data]
                                    : r.data[0],
                                );
                              setBusy(false);
                            });
                          }}
                        />
                        <WorkflowSelectedFiles
                          field={f}
                          value={inputs[f.name]}
                          disabled={busy || !online}
                          onChange={(value) => change(f.name, value)}
                        />
                      </>
                    ) : (
                      <WorkflowValue
                        field={f}
                        value={inputs[f.name]}
                        onChange={(value) => change(f.name, value)}
                        onValidity={(valid) =>
                          setInvalid((old) => ({ ...old, [f.name]: !valid }))
                        }
                      />
                    )}
                  </div>
                ))}
              <button
                className="wf-button wf-primary"
                disabled={
                  busy ||
                  !online ||
                  active(run) ||
                  Object.values(invalid).some(Boolean)
                }
                onClick={() => void start()}
              >
                <Play size={16} />
                {busy ? "正在提交…" : "运行工作流"}
              </button>
            </>
          )}
          {!online && <p className="wf-hint">工作流执行与进度同步需要联网。</p>}
        </section>
        <section className="wf-run-observation">
          <div className="wf-section-heading">
            <h2>运行观测</h2>
            {run && <Status status={run.status} />}
            {run?.queueReason && <p role="status">{run.queueReason}</p>}
          </div>
          {!polling && (
            <button className="wf-button" onClick={() => setPolling(true)}>
              <RefreshCw size={16} />
              恢复进度同步
            </button>
          )}
          {run ? (
            <>
              <div className="wf-run-meta">
                <code>{run.id}</code>
                <span>
                  v{run.definition.revision} ·{" "}
                  {new Date(run.createdAt).toLocaleString()}
                </span>
                {(run.status === "prepared" || active(run)) && (
                  <button
                    className="wf-button"
                    disabled={busy || !online}
                    onClick={() => {
                      setBusy(true);
                      void runApiTask(() => api.cancelWorkflowRun(run.id), {
                        operation: "取消工作流",
                      }).then((r) => {
                        if (r.status === "success") setRun(r.data);
                        setBusy(false);
                      });
                    }}
                  >
                    <Square size={14} />
                    取消运行
                  </button>
                )}
              </div>
              <RunDetail run={run} />
            </>
          ) : (
            <div className="wf-empty">
              <Play size={30} />
              <h3>等待运行</h3>
              <p>运行后将显示每个节点的状态、耗时、输入输出和事件。</p>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
/** 运行状态同时使用文字与颜色，避免仅以颜色表达。 */
function Status({ status }: { status: WorkflowStatus }) {
  return (
    <span className={`wf-status wf-status-${status}`}>
      {statusNames[status]}
    </span>
  );
}
/** 快照中的节点名称和事件用于历史回放，不依赖当前已编辑的定义。 */
function RunDetail({ run }: { run: WorkflowRun }) {
  return (
    <>
      {run.error && (
        <div className="wf-run-error" role="alert">
          <strong>{run.error.code}</strong>
          <p>{run.error.message}</p>
          <small>追踪 ID：{run.error.requestId}</small>
        </div>
      )}
      <ol className="wf-trace">
        {workflowRunNodesInOrder(run).map((state, index) => {
          const node = run.definition.nodes.find((n) => n.id === state.nodeId)!;
          const elapsed = state.startedAt
            ? Math.max(
                0,
                (Date.parse(state.finishedAt ?? new Date().toISOString()) -
                  Date.parse(state.startedAt)) /
                  1000,
              )
            : undefined;
          return (
            <li key={state.nodeId}>
              <details
                open={
                  state.status === "running" || state.status === "failed"
                    ? true
                    : undefined
                }
              >
                <summary>
                  <span className="wf-step-index">
                    {String(index + 1).padStart(2, "0")}
                  </span>
                  <span className="wf-trace-title">
                    <strong>{node.name}</strong>
                    <small>
                      {WORKFLOW_NODE_NAMES[node.kind]}
                      {state.progress ? ` · ${state.progress}` : ""}
                    </small>
                  </span>
                  <span>
                    {elapsed === undefined ? "—" : `${elapsed.toFixed(1)}s`}
                  </span>
                  <Status status={state.status} />
                </summary>
                <div className="wf-trace-body">
                  {state.error && (
                    <p className="wf-error">{state.error.message}</p>
                  )}
                  {!!state.outputs?.sessionId && (
                    <a className="wf-file-link" href="/chat">
                      前往会话列表（会话 ID：{String(state.outputs.sessionId)}）
                    </a>
                  )}
                  <h4>输入</h4>
                  <WorkflowValueView value={state.inputs} label="输入" />
                  {state.referenceGroups &&
                    Object.keys(state.referenceGroups).length > 0 && (
                      <>
                        <h4>参考组数组</h4>
                        <WorkflowValueView
                          value={state.referenceGroups}
                          label="参考组"
                        />
                      </>
                    )}
                  <h4>输出</h4>
                  <WorkflowValueView value={state.outputs} />
                  {state.children?.map((child, childIndex) => (
                    <details
                      key={child.id}
                      open={
                        child.status === "failed" || child.status === "running"
                          ? true
                          : undefined
                      }
                    >
                      <summary>
                        {node.kind === "loop"
                          ? `第 ${childIndex + 1} 轮`
                          : `子工作流：${child.definition.name}`}{" "}
                        · {statusNames[child.status]}
                      </summary>
                      <RunDetail run={child} />
                    </details>
                  ))}
                  <h4>事件</h4>
                  <ul className="wf-events">
                    {state.events.map((event, i) => (
                      <li key={i}>
                        <time>{new Date(event.at).toLocaleTimeString()}</time>
                        <span>{event.message}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </details>
            </li>
          );
        })}
      </ol>
      {run.status === "succeeded" && (
        <div className="wf-final-output">
          <h3>工作流输出</h3>
          <WorkflowValueView value={run.outputs} />
        </div>
      )}
    </>
  );
}
/** 最近运行记录按服务端时间倒序展示，详情可独立恢复。 */
function History() {
  const { runApiTask } = useApiTask();
  const [runs, setRuns] = useState<
      Awaited<ReturnType<typeof api.listWorkflowRuns>>["runs"]
    >([]),
    [loading, setLoading] = useState(true);
  const reload = useCallback(async () => {
    setLoading(true);
    const r = await runApiTask(api.listWorkflowRuns, {
      operation: "读取工作流运行记录",
    });
    if (r.status === "success") setRuns(r.data.runs);
    setLoading(false);
  }, [runApiTask]);
  useEffect(() => {
    void reload();
  }, [reload]);
  return (
    <>
      <header className="wf-page-heading">
        <div>
          <span className="wf-eyebrow">RUN HISTORY</span>
          <h1>运行记录</h1>
          <p>最近 200 次运行，保留当时的定义快照与节点详情。</p>
        </div>
        <button
          className="wf-button"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={16} />
          刷新
        </button>
      </header>
      {loading ? (
        <p className="wf-empty" role="status">
          正在读取记录…
        </p>
      ) : !runs.length ? (
        <div className="wf-empty">
          <Workflow size={32} />
          <h2>还没有运行记录</h2>
          <p>从“运行工作流”开始一次执行。</p>
        </div>
      ) : (
        <div className="wf-workflow-list">
          {runs.map((run) => (
            <button
              className="wf-history-row"
              key={run.id}
              onClick={() =>
                navigateTo({
                  page: "workflow-run",
                  workflowId: run.workflowId,
                  runId: run.id,
                })
              }
            >
              <div>
                <strong>{run.name}</strong>
                <small>{new Date(run.createdAt).toLocaleString()}</small>
              </div>
              <code>{run.id.slice(0, 8)}</code>
              <Status status={run.status} />
              <span>查看详情 →</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}
