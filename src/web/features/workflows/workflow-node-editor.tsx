import { useEffect, useRef, useState } from "react";
import { Plus, X, Trash2, Copy } from "lucide-react";
import {
  WORKFLOW_NODE_NAMES,
  type WorkflowNode,
  type WorkflowCatalog,
  type WorkflowBinding,
  type WorkflowCondition,
  type WorkflowInputField,
  type WorkflowEdge,
} from "../../../shared/workflow-contracts";
import {
  WorkflowCallEditor,
  WorkflowLoopEditor,
} from "./workflow-composition-editor";
import { WorkflowScriptAssist } from "./workflow-script-assist";
import {
  WorkflowInputTools,
  type WorkflowInputToolsProps,
} from "./workflow-input-tools";
import { api, type SessionSummary } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { workflowOutputBindings } from "./workflow-field-guards";
import {
  WorkflowBindingEditor,
  WorkflowFieldList,
  WorkflowJson,
} from "./workflow-fields";

/** 节点属性面板复用各能力目录，输入绑定与执行配置分区呈现。 */
export function WorkflowNodeEditor({
  node,
  nodes,
  edges = [],
  catalog,
  onChange,
  onClose,
  onDelete,
  onCopy,
  onValidity,
  onEditLoop,
  workflowId,
  inputTools,
}: {
  inputTools?: WorkflowInputToolsProps;
  onEditLoop?: () => void;
  workflowId?: string;
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges?: WorkflowEdge[];
  catalog: WorkflowCatalog;
  onChange: (node: WorkflowNode) => void;
  onClose: () => void;
  onDelete: () => void;
  onCopy: () => void;
  onValidity: (key: string, valid: boolean) => void;
}) {
  const { runApiTask } = useApiTask();
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [enumDirectory, setEnumDirectory] = useState(catalog);
  const [refreshingEnums, setRefreshingEnums] = useState(false);
  const enumRefreshPending = useRef(false);
  useEffect(() => setEnumDirectory(catalog), [catalog]);
  const refreshEnumSources = async () => {
    if (enumRefreshPending.current) return;
    enumRefreshPending.current = true;
    setRefreshingEnums(true);
    const result = await runApiTask(() => api.getWorkflowCatalog(), {
      operation: "刷新工作流枚举来源",
    });
    enumRefreshPending.current = false;
    setRefreshingEnums(false);
    if (result.status === "success") setEnumDirectory(result.data);
  };
  const enumRefresh = {
    refreshingEnums,
    onRefreshEnums: () => void refreshEnumSources(),
  };
  const config = node.config;
  const staleOutputs = node.kind === "output"
    ? Object.keys(node.inputs).filter((name) => !node.outputs.some((field) => field.name === name))
    : [];
  const connected = new Set([node.id]);
  // 枚举来源允许来自下游，只用于复制类型约束，不改变执行连线。
  for (let i = 0; i < nodes.length; i++)
    for (const edge of edges)
      if (connected.has(edge.source) || connected.has(edge.target)) {
        connected.add(edge.source);
        connected.add(edge.target);
      }
  const enumSources = nodes
    .filter((n) => connected.has(n.id) && ["aigc", "workflow", "loop"].includes(n.kind))
    .flatMap((n) => {
      const target = enumDirectory.workflows?.find(
        (item) => item.id === n.config.workflowId,
      );
      const fields = n.kind === "aigc"
        ? (enumDirectory.interfaces.find((item) => item.id === n.config.interfaceId)
            ?.fields ?? []).map((field) => ({
              name: field.name,
              values: field.enumValues?.map(String),
            }))
        : n.kind === "loop"
          ? (n.config.loop?.body.nodes.find((item) => item.kind === "input")?.outputs ?? [])
              .map((field) => ({ name: field.name, values: field.enumValues?.map(String) }))
          : target?.unavailable ? [] : target?.enumFields ?? [];
      return fields.flatMap((field) => {
        const values = field.values;
        // 字符串相同的不同类型选项无法唯一回转，不作为可选枚举类型。
        return values?.length && new Set(values).size === values.length
          ? [
              {
                label: `${n.name} / ${field.name}`,
                source: {
                  nodeId: n.id,
                  field: field.name,
                  ...(n.kind === "aigc"
                    ? { interfaceId: n.config.interfaceId! }
                    : n.kind === "loop" ? { loop: true as const } : { workflowId: n.config.workflowId! }),
                },
                values,
              },
            ]
          : [];
      });
    });
  const upstream = new Set<string>();
  for (let i = 0; i < nodes.length; i++)
    for (const edge of edges)
      if (edge.target === node.id || upstream.has(edge.target))
        upstream.add(edge.source);
  const aigc = catalog.interfaces.find(
    (item) => item.id === config.interfaceId,
  );
  const groups = aigc?.referenceGroups ?? [];
  const groupFields = new Set(groups.flatMap((g) => g.fields));
  const patch = (value: Partial<WorkflowNode["config"]>) =>
    onChange({ ...node, config: { ...config, ...value } });
  useEffect(() => {
    let active = true;
    setSessions([]);
    if (
      node.kind === "agent" &&
      config.agentId &&
      config.sessionMode === "fixed"
    )
      void runApiTask(
        async () => {
          const [a, b] = await Promise.all([
            api.listSessions(config.agentId!),
            api.listSessions(config.agentId!, true),
          ]);
          return [...a.sessions, ...b.sessions];
        },
        { operation: "读取 Agent 可用会话" },
      ).then((result) => {
        if (active && result.status === "success") setSessions(result.data);
      });
    return () => {
      active = false;
    };
  }, [config.agentId, config.sessionMode, node.kind, runApiTask]);
  const binding = (name: string, label: string, field?: WorkflowInputField) => (
    <WorkflowBindingEditor
      key={name}
      label={label}
      field={field}
      binding={node.inputs[name]}
      nodes={nodes}
      nodeId={node.id}
      onValidity={(valid) => onValidity(`${node.id}:${name}`, valid)}
      onChange={(value) => {
        const inputs = { ...node.inputs };
        if (value) inputs[name] = value;
        else delete inputs[name];
        onChange({ ...node, inputs });
      }}
    />
  );
  const conditions = config.conditions ?? [];
  const condition = (
    c: WorkflowCondition,
    index: number,
    change: (c: WorkflowCondition) => void,
  ) => (
    <div className="wf-field-item" key={index}>
      <WorkflowBindingEditor
        onValidity={(valid) =>
          onValidity(`${node.id}:condition:${index}:left`, valid)
        }
        label="左值"
        binding={c.left}
        nodes={nodes}
        nodeId={node.id}
        onChange={(v) =>
          change({ ...c, left: v ?? { kind: "literal", value: null } })
        }
      />
      <select
        aria-label="条件运算符"
        value={c.operator}
        onChange={(e) =>
          change({
            ...c,
            operator: e.target.value as WorkflowCondition["operator"],
          })
        }
      >
        {[
          ["eq", "等于"],
          ["ne", "不等于"],
          ["gt", "大于"],
          ["gte", "大于等于"],
          ["lt", "小于"],
          ["lte", "小于等于"],
          ["contains", "包含"],
          ["empty", "为空"],
          ["not_empty", "非空"],
        ].map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
      {!["empty", "not_empty"].includes(c.operator) && (
        <WorkflowBindingEditor
          onValidity={(valid) =>
            onValidity(`${node.id}:condition:${index}:right`, valid)
          }
          label="右值"
          binding={c.right}
          nodes={nodes}
          nodeId={node.id}
          onChange={(v) =>
            change({ ...c, right: v ?? { kind: "literal", value: null } })
          }
        />
      )}
    </div>
  );
  return (
    <aside className="wf-inspector" aria-label="节点配置">
      <header className="wf-inspector-heading">
        <div>
          <strong>{WORKFLOW_NODE_NAMES[node.kind]}节点</strong>
          <small>{node.id}</small>
        </div>
        <button
          type="button"
          className="icon-button"
          aria-label="关闭节点配置"
          onClick={onClose}
        >
          <X size={18} />
        </button>
      </header>
      <div className="wf-inspector-body">
        <label className="wf-field">
          节点名称
          <input
            value={node.name}
            onChange={(e) => onChange({ ...node, name: e.target.value })}
          />
        </label>
        {(node.kind === "semaphore_acquire" || node.kind === "semaphore_release") && <>
          <label className="wf-field">共享资源信号量<select value={config.semaphoreCode ?? ""} onChange={(event) => patch({ semaphoreCode: event.target.value || undefined })}>
            <option value="">选择已配置的信号量</option>
            {(catalog.semaphores ?? []).map((item) => <option key={item.code} value={item.code}>{item.name} · {item.code} · 上限 {item.limit}</option>)}
            {config.semaphoreCode && !catalog.semaphores?.some((item) => item.code === config.semaphoreCode) && <option value={config.semaphoreCode}>{config.semaphoreCode}（不可用）</option>}
          </select></label>
          {binding("count", node.kind === "semaphore_acquire" ? "获取数量" : "释放数量", { name: "count", type: "integer", required: true, min: 1 })}
          <p className="wf-hint">额度不足时按申请顺序等待。只能释放当前运行持有的额度；根工作流结束、报错或取消后自动释放剩余额度。</p>
        </>}
        {node.kind === "loop" && (
          <WorkflowLoopEditor
            node={node}
            nodes={nodes}
            onChange={onChange}
            onValidity={onValidity}
            onEditLoop={onEditLoop}
          />
        )}
        {node.kind === "workflow" && (
          <WorkflowCallEditor
            node={node}
            nodes={nodes}
            catalog={catalog}
            workflowId={workflowId}
            onChange={onChange}
            onValidity={onValidity}
          />
        )}
        {node.kind === "input" && (
          <>
            <h3>工作流入参</h3>
            {inputTools && <WorkflowInputTools node={node} {...inputTools} />}
            <WorkflowFieldList
              fields={node.outputs}
              reserved={inputTools?.reserved}
              systemFields={inputTools?.systemFields}
              enumSources={enumSources}
              {...enumRefresh}
              defaults
              onChange={(outputs) => onChange({ ...node, outputs })}
            />
          </>
        )}
        {node.kind === "output" && (
          <>
            <h3>工作流出参</h3>
            <WorkflowFieldList
              fields={node.outputs}
              enumSources={enumSources}
              {...enumRefresh}
              onChange={(outputs) => onChange({ ...node, outputs, inputs: workflowOutputBindings(node, outputs) })}
            />
            {staleOutputs.length > 0 && (
              <div className="wf-field-item">
                <p className="wf-error" role="alert">
                  未声明的输出绑定：{staleOutputs.join("、")}。请清理后保存工作流。
                </p>
                <button
                  type="button"
                  className="wf-button"
                  onClick={() => onChange({ ...node, inputs: workflowOutputBindings(node) })}
                >
                  清理未声明的输出绑定
                </button>
              </div>
            )}
            <h3>输出绑定</h3>
            {node.outputs.map((f) => binding(f.name, f.name, f))}
          </>
        )}
        {node.kind === "llm" && (
          <>
            <h3>模型与提示词</h3>
            <label className="wf-field">
              模型
              <select
                aria-label="模型"
                value={
                  config.provider && config.modelId
                    ? `${config.provider}\t${config.modelId}`
                    : ""
                }
                onChange={(e) => {
                  const [provider, modelId] = e.target.value.split("\t");
                  const model = catalog.models.find(
                    (m) => m.provider === provider && m.id === modelId,
                  );
                  patch({
                    provider,
                    modelId,
                    temperature: model?.reasoning ? undefined : 0.7,
                    topP: model?.reasoning ? undefined : 1,
                  });
                }}
              >
                <option value="">选择模型</option>
                {catalog.models.map((m) => (
                  <option
                    key={m.provider + m.id}
                    value={`${m.provider}\t${m.id}`}
                  >
                    {m.name} · {m.provider}
                    {m.images ? " · 视觉" : ""}
                  </option>
                ))}
              </select>
            </label>
            <label className="wf-field">
              系统提示词
              <textarea
                rows={5}
                value={config.systemPrompt ?? ""}
                onChange={(e) => patch({ systemPrompt: e.target.value })}
              />
            </label>
            {binding("prompt", "用户 prompt · 必填", {
              name: "prompt",
              type: "string",
              required: true,
            })}
            {binding("images", "图片 · 可选", {
              name: "images",
              type: "image",
              multiple: true,
            })}
            <h3>思考与常见超参</h3>
            <label className="wf-field">
              思考等级
              <select
                aria-label="思考等级"
                value={config.thinking ?? "inherit"}
                onChange={(e) =>
                  patch({ thinking: e.target.value as typeof config.thinking })
                }
              >
                {[
                  "inherit",
                  "off",
                  "minimal",
                  "low",
                  "medium",
                  "high",
                  "xhigh",
                ].map((t) => (
                  <option key={t} value={t}>
                    {t === "inherit" ? "模型默认" : t === "off" ? "关闭" : t}
                  </option>
                ))}
              </select>
            </label>
            <div className="wf-two-fields">
              {(
                [
                  ["temperature", "Temperature", 0.7, 0, 2],
                  ["topP", "Top P", 1, 0, 1],
                  ["maxTokens", "最大输出 tokens", 4096, 1, 1000000],
                  ["frequencyPenalty", "Frequency penalty", 0, -2, 2],
                  ["presencePenalty", "Presence penalty", 0, -2, 2],
                ] as const
              ).map(([key, label, def, min, max]) => (
                <label className="wf-field" key={key}>
                  {label}
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={key === "maxTokens" ? 1 : 0.1}
                    value={config[key] ?? ""}
                    placeholder={
                      key === "temperature" || key === "topP"
                        ? "模型默认"
                        : String(def)
                    }
                    onChange={(e) =>
                      patch({
                        [key]:
                          e.target.value === ""
                            ? undefined
                            : Number(e.target.value),
                      })
                    }
                  />
                  <small>默认 {def}</small>
                </label>
              ))}
            </div>
            <p className="wf-hint">
              参数按模型协议发送。思考模型默认不指定采样参数，留空时使用模型默认。原生及
              Responses 协议的惩罚参数需保持 0；不支持的设置会明确报错。
            </p>
            <h3>自定义超参</h3>
            <WorkflowJson
              label="JSON 请求参数"
              value={config.customParameters ?? {}}
              objectOnly
              onValidity={(valid) => onValidity(`${node.id}:custom`, valid)}
              onChange={(v) =>
                patch({ customParameters: v as Record<string, unknown> })
              }
            />
            <p className="wf-hint">
              同名字段覆盖常见超参；不能覆盖模型、消息、工具、凭据或连接参数。Google
              使用生成配置字段（如 topK）。
            </p>
          </>
        )}
        {node.kind === "agent" && (
          <>
            <h3>Agent 与输入</h3>
            <label className="wf-field">
              Agent
              <select
                value={config.agentId ?? ""}
                onChange={(e) =>
                  patch({ agentId: e.target.value, sessionId: undefined })
                }
              >
                <option value="">选择 Agent</option>
                {catalog.agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
            </label>
            {binding("prompt", "用户 prompt · 必填", {
              name: "prompt",
              type: "string",
              required: true,
            })}
            {binding("files", "文件 · 可选", {
              name: "files",
              type: "file",
              multiple: true,
            })}
            <h3>会话行为</h3>
            <label className="wf-field">
              目标会话
              <select
                value={config.sessionMode ?? "new"}
                onChange={(e) =>
                  patch({ sessionMode: e.target.value as "new" | "fixed" })
                }
              >
                <option value="new">每次新建会话</option>
                <option value="fixed">每次发送至同一会话</option>
              </select>
            </label>
            {config.sessionMode === "fixed" && (
              <label className="wf-field">
                固定会话
                <select
                  value={config.sessionId ?? ""}
                  onChange={(e) => patch({ sessionId: e.target.value })}
                >
                  <option value="">选择该 Agent 的会话</option>
                  {sessions.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name || s.firstMessage || s.id}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="wf-check">
              <input
                type="checkbox"
                checked={!!config.archiveAfterCompletion}
                onChange={(e) =>
                  patch({ archiveAfterCompletion: e.target.checked })
                }
              />
              执行完成后归档
            </label>
            <p className="wf-hint">
              固定会话归档后，下次执行将重新打开；人工问答会停止工作流并保留会话入口。
            </p>
          </>
        )}
        {node.kind === "aigc" && (
          <>
            <h3>创作接口</h3>
            <label className="wf-field">
              AIGC 工具
              <select
                value={config.interfaceId ?? ""}
                onChange={(e) => {
                  const item = catalog.interfaces.find(
                    (i) => i.id === e.target.value,
                  );
                  onChange({
                    ...node,
                    config: { interfaceId: e.target.value },
                    inputs: {},
                    outputs: item?.outputs ?? [
                      { name: "files", type: "file", multiple: true },
                    ],
                  });
                }}
              >
                <option value="">选择创作与运行中的接口</option>
                {catalog.interfaces.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.name}
                  </option>
                ))}
              </select>
            </label>
            {aigc?.fields
              .filter((f) => !groupFields.has(f.name))
              .map((f) =>
                binding(f.name, `${f.name}${f.required ? " · 必填" : ""}`, f),
              )}
            {groups.map((group) => {
              const setting = config.referenceGroups?.[group.id];
              return (
                <section
                  className="wf-field-item"
                  key={group.id}
                  aria-label={`${group.label} 参考组`}
                >
                  <strong>{group.label}</strong>
                  <label className="wf-field">
                    输入方式
                    <select
                      aria-label={`${group.label} 输入方式`}
                      value={setting ? "array" : "split"}
                      onChange={(event) => {
                        const referenceGroups = { ...config.referenceGroups };
                        const inputs = { ...node.inputs };
                        if (event.target.value === "array") {
                          referenceGroups[group.id] = { mode: "array" };
                          group.fields.forEach((name) => delete inputs[name]);
                        } else delete referenceGroups[group.id];
                        onChange({
                          ...node,
                          inputs,
                          config: { ...config, referenceGroups },
                        });
                      }}
                    >
                      <option value="split">逐项输入</option>
                      <option value="array">数组输入</option>
                    </select>
                  </label>
                  <p className="wf-hint">
                    最多 {group.fields.length}{" "}
                    项，按原槽位顺序填入。切换方式会清除本组现有绑定。
                  </p>
                  {setting ? (
                    <WorkflowBindingEditor
                      label={`${group.label} 数组`}
                      nodeId={node.id}
                      nodes={nodes.filter((n) => upstream.has(n.id))}
                      referenceOnly
                      field={{
                        name: group.label,
                        type: group.type,
                        multiple: true,
                        maxItems: group.fields.length,
                      }}
                      binding={setting.binding}
                      onChange={(value) =>
                        patch({
                          referenceGroups: {
                            ...config.referenceGroups,
                            [group.id]: { mode: "array", binding: value },
                          },
                        })
                      }
                      onValidity={(valid) =>
                        onValidity(`${node.id}:group:${group.id}`, valid)
                      }
                    />
                  ) : (
                    group.fields.map((name) => {
                      const field = aigc?.fields.find((f) => f.name === name);
                      return field ? binding(name, name, field) : null;
                    })
                  )}
                </section>
              );
            })}
          </>
        )}
        {node.kind === "condition" && (
          <>
            <h3>分支条件</h3>
            <label className="wf-field">
              组合方式
              <select
                value={config.conditionMode ?? "all"}
                onChange={(e) =>
                  patch({ conditionMode: e.target.value as "all" | "any" })
                }
              >
                <option value="all">全部满足 · AND</option>
                <option value="any">任一满足 · OR</option>
              </select>
            </label>
            {conditions.map((c, i) => (
              <div key={i}>
                {condition(c, i, (next) =>
                  patch({
                    conditions: conditions.map((old, j) =>
                      i === j ? next : old,
                    ),
                  }),
                )}
                <button
                  type="button"
                  className="wf-text-button"
                  onClick={() =>
                    patch({ conditions: conditions.filter((_, j) => i !== j) })
                  }
                >
                  移除此条件
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wf-button"
              onClick={() =>
                patch({
                  conditions: [
                    ...conditions,
                    {
                      left: { kind: "literal", value: true },
                      operator: "eq",
                      right: { kind: "literal", value: true },
                    },
                  ],
                })
              }
            >
              <Plus size={15} />
              添加条件
            </button>
            <p className="wf-hint">从画布右侧 IF / ELSE 端口分别连接分支。</p>
          </>
        )}
        {node.kind === "select" && (
          <>
            <h3>选择输入值</h3>
            <label className="wf-field">
              选择方式
              <select
                value={config.selectMode ?? "first_available"}
                onChange={(e) =>
                  patch({
                    selectMode: e.target.value as
                      "first_available" | "condition",
                    selectCondition: {
                      left: { kind: "literal", value: true },
                      operator: "eq",
                      right: { kind: "literal", value: true },
                    },
                  })
                }
              >
                <option value="first_available">
                  按顺序选择首个已执行输入
                </option>
                <option value="condition">按条件选择两个输入之一</option>
              </select>
            </label>
            {config.selectMode === "condition" &&
              config.selectCondition &&
              condition(config.selectCondition, 0, (c) =>
                patch({ selectCondition: c }),
              )}
            {(config.candidates ?? []).map((b, i) => (
              <div key={i}>
                <WorkflowBindingEditor
                  onValidity={(valid) =>
                    onValidity(`${node.id}:candidate:${i}`, valid)
                  }
                  label={`候选 ${i + 1}`}
                  binding={b}
                  nodes={nodes}
                  nodeId={node.id}
                  onChange={(v) =>
                    patch({
                      candidates: config.candidates!.map((old, j) =>
                        i === j ? (v ?? { kind: "literal", value: null }) : old,
                      ),
                    })
                  }
                />
                <button
                  type="button"
                  className="wf-text-button"
                  onClick={() =>
                    patch({
                      candidates: config.candidates!.filter((_, j) => i !== j),
                    })
                  }
                >
                  移除此候选
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wf-button"
              onClick={() =>
                patch({
                  candidates: [
                    ...(config.candidates ?? []),
                    { kind: "literal", value: "" },
                  ],
                })
              }
            >
              <Plus size={15} />
              添加候选
            </button>
            <h3>返回类型</h3>
            <WorkflowFieldList
              fields={node.outputs}
              enumSources={enumSources}
              {...enumRefresh}
              onChange={(outputs) =>
                onChange({ ...node, outputs: outputs.slice(0, 1) })
              }
            />
          </>
        )}
        {node.kind === "javascript" && (
          <>
            <h3>脚本输入</h3>
            {Object.keys(node.inputs).map((name) => (
              <div key={name}>
                {binding(name, name)}
                <button
                  type="button"
                  className="wf-text-button"
                  onClick={() => {
                    const inputs = { ...node.inputs };
                    delete inputs[name];
                    onChange({ ...node, inputs });
                  }}
                >
                  删除输入
                </button>
              </div>
            ))}
            <button
              type="button"
              className="wf-button"
              onClick={() => {
                let index = 1;
                while (Object.hasOwn(node.inputs, `value_${index}`)) index++;
                const name = `value_${index}`;
                onChange({
                  ...node,
                  inputs: {
                    ...node.inputs,
                    [name]: { kind: "literal", value: "" },
                  },
                });
              }}
            >
              <Plus size={15} />
              添加输入
            </button>
            <div className="wf-section-heading">
              <h3>JavaScript</h3>
              <WorkflowScriptAssist
                node={node}
                nodes={nodes}
                catalog={catalog}
                onApply={(script) => patch({ script })}
              />
            </div>
            <label className="wf-field">
              函数体 · return 输出对象
              <textarea
                className="wf-code wf-script"
                spellCheck={false}
                value={config.script ?? ""}
                onChange={(e) => patch({ script: e.target.value })}
              />
            </label>
            <label className="wf-field">
              执行超时（毫秒）
              <input
                type="number"
                min={100}
                max={5000}
                value={config.timeoutMs ?? 1000}
                onChange={(e) => patch({ timeoutMs: Number(e.target.value) })}
              />
            </label>
            <p className="wf-hint">
              通过 inputs 读取输入，return 返回输出对象。可使用 console.log
              记录事件；不支持网络、文件、Node API 和异步 Promise。内存上限 32
              MiB。
            </p>
            <h3>输出定义</h3>
            <WorkflowFieldList
              fields={node.outputs}
              enumSources={enumSources}
              {...enumRefresh}
              onChange={(outputs) => onChange({ ...node, outputs })}
            />
          </>
        )}
        {!["input", "output", "select", "javascript", "semaphore_acquire", "semaphore_release"].includes(node.kind) && (
          <>
            <h3>节点输出</h3>
            {node.outputs.map((f) => (
              <div className="wf-output-row" key={f.name}>
                <code>{f.name}</code>
                <span>
                  {f.type}
                  {f.multiple ? "[]" : ""}
                </span>
              </div>
            ))}
          </>
        )}
      </div>
      <footer className="wf-inspector-footer">
        <span>修改后保存工作流</span>
        {!["input", "output"].includes(node.kind) && (
          <div className="wf-actions">
            <button
              type="button"
              className="icon-button"
              aria-label="复制节点"
              onClick={onCopy}
            >
              <Copy size={16} />
            </button>
            <button
              type="button"
              className="icon-button wf-error"
              aria-label="删除节点"
              onClick={onDelete}
            >
              <Trash2 size={16} />
            </button>
          </div>
        )}
      </footer>
    </aside>
  );
}
