import { Button } from "../../ui/controls";
import { Checkbox } from "../../ui/choice";
import { SearchSelect } from "../../ui/search-select";
import { useEffect, useRef, useState } from "react";
import type {
  WorkflowBinding,
  WorkflowCatalog,
  WorkflowDefinition,
  WorkflowLoop,
  WorkflowNode,
} from "../../../shared/workflow-contracts";
import { workflowLoopOutputs } from "../../../shared/workflow-contracts";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { WorkflowBindingEditor, WorkflowValue } from "./workflow-fields";
import { workflowLoopInputBindings } from "./workflow-field-guards";

interface CompositionProps {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  onChange: (node: WorkflowNode) => void;
  onValidity: (key: string, valid: boolean) => void;
}

/** 目标参数独立读取；响应序号避免快速切换目标时应用过期结果。 */
export function WorkflowCallEditor({
  node,
  nodes,
  catalog,
  workflowId,
  onChange,
  onValidity,
}: CompositionProps & { catalog: WorkflowCatalog; workflowId?: string }) {
  const { runApiTask } = useApiTask();
  const [target, setTarget] = useState<WorkflowDefinition>();
  const sequence = useRef(0);
  const current = useRef(node);
  current.current = node;
  useEffect(() => {
    const ticket = ++sequence.current;
    setTarget(undefined);
    if (node.config.workflowId)
      void runApiTask(() => api.getWorkflow(node.config.workflowId!), {
        operation: "读取子工作流参数",
      }).then((result) => {
        if (ticket === sequence.current && result.status === "success")
          setTarget(result.data);
      });
    return () => {
      sequence.current++;
    };
  }, [node.config.workflowId, runApiTask]);
  const sync = (definition: WorkflowDefinition) => {
    const inputFields = definition.nodes.find(
      (n) => n.kind === "input",
    )!.outputs;
    const inputs = Object.fromEntries(
      Object.entries(current.current.inputs).filter(([name]) =>
        inputFields.some((f) => f.name === name),
      ),
    );
    onChange({
      ...current.current,
      inputs,
      outputs: structuredClone(
        definition.nodes
          .find((n) => n.kind === "output")!
          .outputs.map((field) => ({ ...field, enumSource: undefined })),
      ),
      config: { ...current.current.config, workflowId: definition.id },
    });
  };
  const select = async (id: string) => {
    const ticket = ++sequence.current;
    const result = await runApiTask(
      async () => {
        const definition = await api.getWorkflow(id);
        return definition;
      },
      { operation: "选择子工作流" },
    );
    if (ticket !== sequence.current || result.status !== "success") return;
    sync(result.data);
    setTarget(result.data);
  };
  return (
    <>
      <h3>调用工作流</h3>
      <label className="wf-field">
        目标工作流
        <SearchSelect
          ariaLabel="目标工作流"
          value={node.config.workflowId ?? ""}
          onChange={(next) => {
            if (next) void select(next);
            else {
              sequence.current++;
              onChange({
                ...node,
                config: { ...node.config, workflowId: undefined },
                inputs: {},
                outputs: [],
              });
            }
          }}
          options={[
            { value: "", label: "选择 DAG 工作流" },
            ...(catalog.workflows ?? []).map((item) => {
            const cycle =
              item.id === workflowId ||
              (!!workflowId && item.dependencies.includes(workflowId));
            return { value: item.id, label: `${item.name}${cycle
                  ? " · 会形成循环依赖"
                  : item.unavailable
                    ? ` · 不可用：${item.unavailable}`
                    : ""}`, disabled: cycle || !!item.unavailable };
          }),
          ]}
        />
      </label>
      <p className="wf-hint">
        按目标工作流的入参和出参调用；本次运行会固定整棵调用树的定义。
      </p>
      {target && (
        <>
          <Button
            type="button"
            className="wf-button"
            onClick={() =>
              void runApiTask(() => api.getWorkflow(target.id), {
                operation: "同步子工作流参数",
              }).then((result) => {
                if (
                  result.status === "success" &&
                  current.current.config.workflowId === result.data.id
                ) {
                  setTarget(result.data);
                  sync(result.data);
                }
              })
            }
          >
            同步最新参数 · v{target.revision}
          </Button>
          <h3>工作流输入</h3>
          {target.nodes
            .find((n) => n.kind === "input")!
            .outputs.map((field) => (
              <WorkflowBindingEditor
                key={field.name}
                label={field.name}
                field={field}
                binding={node.inputs[field.name]}
                nodes={nodes}
                nodeId={node.id}
                onValidity={(valid) =>
                  onValidity(`${node.id}:call:${field.name}`, valid)
                }
                onChange={(binding) => {
                  const inputs = { ...node.inputs };
                  if (binding) inputs[field.name] = binding;
                  else delete inputs[field.name];
                  onChange({ ...node, inputs });
                }}
              />
            ))}
        </>
      )}
    </>
  );
}

/** 循环配置沿用现有绑定控件，循环变量与常规输入使用同一份类型声明。 */
export function WorkflowLoopEditor({
  node,
  nodes,
  onChange,
  onValidity,
  onEditLoop,
}: CompositionProps & { onEditLoop?: () => void }) {
  const loop = node.config.loop!;
  const input = loop.body.nodes.find((n) => n.kind === "input")!;
  const output = loop.body.nodes.find((n) => n.kind === "output")!;
  const cleaned = workflowLoopInputBindings(node, loop.body);
  const stale = [
    ...Object.keys(node.inputs).filter(
      (name) => !Object.hasOwn(cleaned.inputs, name),
    ),
    ...Object.keys(loop.state).filter(
      (name) => !Object.hasOwn(cleaned.state, name),
    ),
  ];
  const patch = (change: Partial<WorkflowLoop>) => {
    const next = { ...loop, ...change };
    onChange({
      ...node,
      config: { ...node.config, loop: next },
      outputs: workflowLoopOutputs(next, node.outputs),
    });
  };
  const binding = (
    label: string,
    value: WorkflowBinding | undefined,
    change: (value: WorkflowBinding) => void,
    field?: import("../../../shared/workflow-contracts").WorkflowField,
    sources = nodes,
  ) => (
    <WorkflowBindingEditor
      label={label}
      binding={value}
      field={field}
      nodes={sources}
      nodeId={sources === nodes ? node.id : "loop_condition"}
      onValidity={(valid) => onValidity(`${node.id}:loop:${label}`, valid)}
      onChange={(next) => change(next ?? { kind: "literal", value: null })}
    />
  );
  return (
    <>
      {stale.length > 0 && (
        <div className="wf-field">
          <p className="wf-error" role="alert">
            无效的循环入参映射或变量：{[...new Set(stale)].join("、")}
            。参数已删除、改名或属于系统参数，请清理旧配置。
          </p>
          <Button
            type="button"
            className="wf-button"
            onClick={() =>
              onChange({
                ...node,
                inputs: cleaned.inputs,
                config: {
                  ...node.config,
                  loop: { ...loop, state: cleaned.state },
                },
              })
            }
          >
            清理无效映射
          </Button>
        </div>
      )}
      <h3>循环方式</h3>
      <label className="wf-field">
        循环模式
        <SearchSelect
          ariaLabel="循环模式"
          value={loop.mode}
          onChange={(next) => {
            const mode = next as WorkflowLoop["mode"];
            const body = structuredClone(loop.body);
            if (
              mode === "array" &&
              !input.outputs.some((field) => field.name === "item")
            )
              body.nodes
                .find((n) => n.kind === "input")!
                .outputs.push({ name: "item", type: "string", required: true });
            if (mode !== "array") {
              const bodyInput = body.nodes.find((n) => n.kind === "input")!;
              bodyInput.outputs = bodyInput.outputs.filter(
                (field) => field.name !== "item",
              );
            }
            patch({ mode, body });
          }}
          options={[
            { value: "count", label: "按次数循环" },
            { value: "array", label: "按数组迭代" },
            { value: "while", label: "while 条件循环" },
          ]}
        />
      </label>
      <label className="wf-field">
        最大迭代次数
        <input
          aria-label="最大迭代次数"
          type="number"
          min={1}
          max={100}
          value={loop.maxIterations}
          onChange={(event) =>
            patch({ maxIterations: Number(event.target.value) })
          }
        />
      </label>
      {loop.mode === "count" &&
        binding("循环次数", loop.count, (count) => patch({ count }), {
          name: "count",
          type: "integer",
          required: true,
        })}
      {loop.mode === "array" &&
        binding("迭代数组", loop.items, (items) => patch({ items }), {
          ...(input.outputs.find((field) => field.name === "item") ?? {
            name: "item",
            type: "string" as const,
          }),
          multiple: true,
        })}
      {loop.mode === "while" && (
        <>
          <h3>每轮执行前判断</h3>
          {binding(
            "while 左值",
            loop.condition.left,
            (left) => patch({ condition: { ...loop.condition, left } }),
            undefined,
            [input],
          )}
          <label className="wf-field">
            运算符
            <SearchSelect
              ariaLabel="while 运算符"
              value={loop.condition.operator}
              onChange={(next) => patch({
                  condition: {
                    ...loop.condition,
                    operator: next as WorkflowLoop["condition"]["operator"],
                  },
                })}
              options={Object.entries({
                eq: "等于",
                ne: "不等于",
                gt: "大于",
                gte: "大于等于",
                lt: "小于",
                lte: "小于等于",
                contains: "包含",
                empty: "为空",
                not_empty: "非空",
              }).map(([value, label]) => ({ value: value, label: label }))}
            />
          </label>
          {!["empty", "not_empty"].includes(loop.condition.operator) &&
            binding(
              "while 右值",
              loop.condition.right,
              (right) => patch({ condition: { ...loop.condition, right } }),
              undefined,
              [input],
            )}
        </>
      )}
      <h3>循环体</h3>
      <Button type="button" className="wf-button" onClick={onEditLoop}>
        编辑循环体 · {loop.body.nodes.length} 个节点
      </Button>
      <p className="wf-hint">
        在内部输入节点声明参数。index 从 0 开始；数组模式提供
        item。内部输出节点声明每轮产出。
      </p>
      {input.outputs
        .filter((field) => !["index", "item"].includes(field.name))
        .map((field) => (
          <section className="wf-field-item" key={field.name}>
            <label className="wf-check">
              <Checkbox

                checked={!!loop.state[field.name]}
                onChange={(event) => {
                  const state = { ...loop.state },
                    inputs = { ...node.inputs };
                  if (event.target.checked) {
                    state[field.name] = {
                      initial: inputs[field.name] ?? {
                        kind: "literal",
                        value: field.defaultValue ?? null,
                      },
                      output:
                        output.outputs.find((f) => f.name === field.name)
                          ?.name ?? "",
                    };
                    delete inputs[field.name];
                  } else {
                    inputs[field.name] = state[field.name].initial;
                    delete state[field.name];
                  }
                  const next = { ...loop, state };
                  onChange({
                    ...node,
                    inputs,
                    config: { ...node.config, loop: next },
                    outputs: workflowLoopOutputs(next, node.outputs),
                  });
                }}
              />
              {field.name} 作为循环变量
            </label>
            {loop.state[field.name] ? (
              <>
                {binding(
                  `${field.name} 初始值`,
                  loop.state[field.name].initial,
                  (initial) =>
                    patch({
                      state: {
                        ...loop.state,
                        [field.name]: { ...loop.state[field.name], initial },
                      },
                    }),
                  field,
                )}
                <label className="wf-field">
                  每轮更新来源
                  <SearchSelect
                    ariaLabel={`${field.name} 更新来源`}
                    value={loop.state[field.name].output}
                    onChange={(next) => patch({
                        state: {
                          ...loop.state,
                          [field.name]: {
                            ...loop.state[field.name],
                            output: next,
                          },
                        },
                      })}
                    options={[
                      { value: "", label: "选择内部出参" },
                      ...output.outputs.map((f) => ({ value: f.name, label: `${f.name} · ${f.type}${f.multiple ? "[]" : ""}` })),
                    ]}
                  />
                </label>
              </>
            ) : (
              binding(
                field.name,
                node.inputs[field.name],
                (value) =>
                  onChange({
                    ...node,
                    inputs: { ...node.inputs, [field.name]: value },
                  }),
                field,
              )
            )}
          </section>
        ))}
      <h3>接出循环的产出</h3>
      <p className="wf-hint">
        外部引用此节点的命名输出。收集单值保留轮次顺序，数组合并为一维；最后一轮可设置零次执行的默认值。
      </p>
      {output.outputs.map((field) => {
        const mapping = loop.outputs[field.name];
        const publicField = node.outputs.find((f) => f.name === field.name);
        return (
          <section className="wf-field-item" key={field.name}>
            <label className="wf-field">
              {field.name} 汇总方式
              <SearchSelect
                ariaLabel={`${field.name} 汇总方式`}
                value={mapping?.mode ?? "none"}
                onChange={(next) => {
                  const outputs = { ...loop.outputs };
                  if (next === "none") delete outputs[field.name];
                  else
                    outputs[field.name] = {
                      field: field.name,
                      mode: next as
                        "collect" | "flatten" | "last",
                    };
                  patch({ outputs });
                }}
                options={[
                  { value: "none", label: "不接出" },
                  { value: field.multiple ? "flatten" : "collect", label: field.multiple ? "合并每轮数组" : "收集每轮单值" },
                  { value: "last", label: "取最后一轮" },
                ]}
              />
            </label>
            {mapping?.mode === "last" && publicField && (
              <>
                <label className="wf-check">
                  <Checkbox

                    checked={publicField.defaultValue !== undefined}
                    onChange={(event) =>
                      onChange({
                        ...node,
                        outputs: node.outputs.map((f) =>
                          f.name === field.name
                            ? {
                                ...f,
                                defaultValue: event.target.checked
                                  ? f.multiple
                                    ? []
                                    : f.type === "boolean"
                                      ? false
                                      : ["integer", "float"].includes(f.type)
                                        ? 0
                                        : f.type === "object"
                                          ? {}
                                          : ""
                                  : undefined,
                              }
                            : f,
                        ),
                      })
                    }
                  />
                  零次执行使用默认值
                </label>
                {publicField.defaultValue !== undefined && (
                  <WorkflowValue
                    field={publicField}
                    value={publicField.defaultValue}
                    onValidity={(valid) =>
                      onValidity(`${node.id}:loop:default:${field.name}`, valid)
                    }
                    onChange={(defaultValue) =>
                      onChange({
                        ...node,
                        outputs: node.outputs.map((f) =>
                          f.name === field.name ? { ...f, defaultValue } : f,
                        ),
                      })
                    }
                  />
                )}
              </>
            )}
          </section>
        );
      })}
    </>
  );
}
