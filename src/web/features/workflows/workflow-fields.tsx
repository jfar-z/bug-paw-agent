import { Button, FilePickerButton } from "../../ui/controls";
import { Checkbox } from "../../ui/choice";
import { SearchSelect } from "../../ui/search-select";
import { isMediaReference } from "../../../shared/media-library-contracts";
import {
  workflowFieldNameErrors,
  workflowSystemFieldIndices,
} from "./workflow-field-guards";
import { useEffect, useId, useRef, useState } from "react";
import { WorkflowFilePicker } from "./workflow-file-picker";
import { api } from "../../api";
import { useApiTask } from "../../api-task-provider";
import { ArrowUp, ArrowDown, Plus, Trash2 } from "lucide-react";
import {
  WORKFLOW_TYPES,
  type WorkflowBinding,
  type WorkflowField,
  type WorkflowInputField,
  type WorkflowFile,
  type WorkflowNode,
} from "../../../shared/workflow-contracts";

/** JSON 编辑保留未完成文本，同时将校验结果反馈给保存按钮。 */
export function WorkflowJson({
  value,
  onChange,
  onValidity,
  label = "JSON",
  objectOnly = false,
}: {
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
  label?: string;
  objectOnly?: boolean;
}) {
  const serialized = JSON.stringify(value ?? {}, null, 2),
    [text, setText] = useState(serialized),
    [error, setError] = useState("");
  const id = useId();
  useEffect(() => {
    // 同一次有效键入不重排文本或跳走光标；外部值变化时才同步编辑器。
    try {
      if (JSON.stringify(JSON.parse(text)) === JSON.stringify(value ?? {}))
        return;
    } catch {
      // 尚未完成的 JSON 在外部值变化时重置。
    }
    setText(serialized);
    setError("");
  }, [serialized]);
  useEffect(() => () => onValidity?.(true), []);
  return (
    <label className="wf-field">
      {label}
      <textarea
        aria-label={label}
        className="wf-code"
        value={text}
        spellCheck={false}
        aria-invalid={!!error}
        aria-describedby={error ? id : undefined}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          try {
            const parsed = JSON.parse(next);
            if (
              objectOnly &&
              (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            )
              throw new Error("需要 JSON 对象");
            setError("");
            onValidity?.(true);
            onChange(parsed);
          } catch {
            setError(
              objectOnly ? "请输入有效 JSON 对象。" : "请输入有效 JSON。",
            );
            onValidity?.(false);
          }
        }}
      />
      {error && (
        <small id={id} className="wf-error">
          {error}
        </small>
      )}
    </label>
  );
}

/** 常量控件按声明类型保留 false、0 和空字符串；不通过字符串猜测类型。 */
export function WorkflowValue({
  fileDirectory = "runtime",
  field,
  value,
  onChange,
  onValidity,
}: {
  field: WorkflowInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
  fileDirectory?: "runtime" | "constants";
}) {
  if (field.enumValues?.length)
    return (
      <WorkflowEnumValue
        field={field}
        value={value}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
  if (["image", "video", "audio", "file"].includes(field.type))
    return (
      <WorkflowMediaValue
        directory={fileDirectory}
        field={field}
        value={value}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
  if (field.multiple || field.type === "object")
    return (
      <WorkflowJson
        label={field.description || field.name}
        value={value ?? (field.multiple ? [] : {})}
        onChange={onChange}
        onValidity={onValidity}
      />
    );
  if (field.type === "boolean")
    return (
      <label className="wf-check wf-boolean-value">
        <Checkbox

          checked={value === true}
          onChange={(e) => onChange(e.target.checked)}
        />
        <span>{field.description || field.name}</span>
      </label>
    );
  if (field.type === "integer" || field.type === "float")
    return (
      <input
        aria-label={field.name}
        type="number"
        value={value === undefined || value === null ? "" : String(value)}
        min={field.min}
        max={field.max}
        step={field.type === "integer" ? 1 : "any"}
        onChange={(e) =>
          onChange(e.target.value === "" ? undefined : Number(e.target.value))
        }
      />
    );
  return (
    <textarea
      aria-label={field.name}
      rows={3}
      value={typeof value === "string" ? value : ""}
      onChange={(e) => onChange(e.target.value)}
    />
  );
}

/** 参数定义供输入、输出及脚本共用；输出不设置默认值以免掩盖执行遗漏。 */
export function WorkflowFieldList({
  fields: declaredFields,
  onChange,
  defaults = false,
  reserved = [],
  systemFields = [],
  enumSources = [],
  onRefreshEnums,
  refreshingEnums = false,
}: {
  fields: WorkflowField[];
  onChange: (fields: WorkflowField[]) => void;
  defaults?: boolean;
  reserved?: string[];
  systemFields?: string[];
  onRefreshEnums?: () => void;
  refreshingEnums?: boolean;
  enumSources?: {
    label: string;
    source: NonNullable<WorkflowField["enumSource"]>;
    values: string[];
  }[];
}) {
  const id = useId();
  // 系统声明固定排在普通参数前，避免普通参数误用同名时取代原系统声明。
  const declaredSystem = workflowSystemFieldIndices(
    declaredFields,
    systemFields,
  );
  const fields = systemFields.length
    ? [
        ...declaredFields.filter((_, index) => declaredSystem.has(index)),
        ...declaredFields.filter((_, index) => !declaredSystem.has(index)),
      ]
    : declaredFields;
  const errors = workflowFieldNameErrors(fields, reserved, systemFields);
  const system = workflowSystemFieldIndices(fields, systemFields);
  const update = (index: number, patch: Partial<WorkflowField>) =>
    onChange(fields.map((f, i) => (i === index ? { ...f, ...patch } : f)));
  return (
    <div className="wf-fields">
      {fields.map((field, index) => (
        <section key={index} className="wf-field-item">
          {system.has(index) ? (
            <div className="wf-field">
              <strong>系统参数 · {field.name}</strong>
              <small className="wf-hint">
                {field.name === "index"
                  ? "integer · 当前迭代序号，从 0 开始，由循环自动提供。"
                  : "当前数组元素，由循环自动提供；可调整元素类型。"}
              </small>
            </div>
          ) : (
            <div className="wf-row">
              <input
                aria-label={`参数 ${index + 1} 名称`}
                placeholder="参数名，如 prompt"
                value={field.name}
                aria-invalid={!!errors[index]}
                aria-describedby={errors[index] ? `${id}-${index}` : undefined}
                onChange={(e) => update(index, { name: e.target.value })}
              />
              {[-1, 1].map((direction) => (
                <button
                  key={direction}
                  type="button"
                  className="icon-button"
                  aria-label={`${direction < 0 ? "上移" : "下移"}参数 ${field.name}`}
                  disabled={
                    index + direction < 0 ||
                    index + direction >= fields.length ||
                    system.has(index + direction)
                  }
                  onClick={() => {
                    const next = [...fields];
                    [next[index], next[index + direction]] = [
                      next[index + direction],
                      next[index],
                    ];
                    onChange(next);
                  }}
                >
                  {direction < 0 ? (
                    <ArrowUp size={15} />
                  ) : (
                    <ArrowDown size={15} />
                  )}
                </button>
              ))}
              <button
                type="button"
                className="icon-button"
                aria-label={`删除参数 ${field.name}`}
                onClick={() => onChange(fields.filter((_, i) => i !== index))}
              >
                <Trash2 size={15} />
              </button>
            </div>
          )}
          {errors[index] && (
            <small className="wf-error" id={`${id}-${index}`} role="alert">
              {errors[index]}
            </small>
          )}
          {!(system.has(index) && field.name === "index") && (
            <>
              <SearchSelect
                ariaLabel={`${field.name} 类型`}
                value={field.enumValues ? "enum" : field.type}
                onChange={(next) => update(index, {
                    type:
                      next === "enum"
                        ? "string"
                        : (next as WorkflowField["type"]),
                    enumValues: next === "enum" ? [] : undefined,
                    enumSource: undefined,
                    defaultValue: undefined,
                  })}
                options={[
                  ...WORKFLOW_TYPES.map((t) => ({ value: t, label: t })),
                  { value: "enum", label: "枚举 · string" },
                ]}
              />
              {field.enumValues && (
                <div className="wf-field">
                  <label>
                    枚举来源
                    <SearchSelect
                      ariaLabel={`${field.name} 枚举来源`}
                      value={
                        field.enumSource ? JSON.stringify(field.enumSource) : ""
                      }
                      onChange={(next) => {
                        const choice = enumSources.find(
                          (s) =>
                            JSON.stringify(s.source) === next,
                        );
                        if (choice)
                          update(index, {
                            enumSource: choice.source,
                            enumValues: choice.values,
                            defaultValue: undefined,
                          });
                      }}
                      options={[
                        { value: "", label: "选择已连接 AIGC、工作流或循环节点的枚举入参", disabled: true },
                        ...(field.enumSource &&
                        !enumSources.some(
                          (s) =>
                            JSON.stringify(s.source) ===
                            JSON.stringify(field.enumSource),
                        ) ? [{ value: JSON.stringify(field.enumSource), label: "枚举来源已失效，请重新选择", disabled: true }] : []),
                        ...enumSources.map((source) => ({ value: JSON.stringify(source.source), label: source.label })),
                      ]}
                    />
                  </label>
                  <small className="wf-hint">
                    作为字符串传递，可用于字符串参数和 AIGC 枚举参数。
                  </small>
                  {onRefreshEnums && (
                    <Button
                      type="button"
                      className="wf-button"
                      aria-label={`${field.name} 刷新枚举来源`}
                      disabled={refreshingEnums}
                      onClick={onRefreshEnums}
                    >
                      {refreshingEnums ? "正在刷新…" : "刷新枚举来源"}
                    </Button>
                  )}
                  <small>
                    {field.enumValues.length
                      ? field.enumValues.join(" / ")
                      : "请先连接 AIGC、工作流或循环节点，再选择其枚举入参。"}
                  </small>
                  {field.enumSource &&
                    (() => {
                      const current = enumSources.find(
                        (s) =>
                          JSON.stringify(s.source) ===
                          JSON.stringify(field.enumSource),
                      );
                      return current &&
                        JSON.stringify(current.values) !==
                          JSON.stringify(field.enumValues) ? (
                        <Button
                          type="button"
                          className="wf-button"
                          onClick={() =>
                            update(index, {
                              enumValues: current.values,
                              defaultValue: undefined,
                            })
                          }
                        >
                          更新枚举选项
                        </Button>
                      ) : null;
                    })()}
                </div>
              )}
              <div className="wf-row">
                <label className="wf-check">
                  <Checkbox

                    checked={!!field.multiple}
                    onChange={(e) =>
                      update(index, {
                        multiple: e.target.checked,
                        defaultValue: undefined,
                      })
                    }
                  />
                  数组
                </label>
                {!system.has(index) && (
                  <label className="wf-check">
                    <Checkbox

                      checked={!!field.required}
                      onChange={(e) =>
                        update(index, { required: e.target.checked })
                      }
                    />
                    必填
                  </label>
                )}
              </div>
              {!system.has(index) && (
                <input
                  aria-label={`${field.name} 说明`}
                  placeholder="参数说明"
                  value={field.description ?? ""}
                  onChange={(e) =>
                    update(index, { description: e.target.value })
                  }
                />
              )}
              {defaults &&
                !system.has(index) &&
                ["image", "video", "audio", "file"].includes(field.type) && (
                  <div className="wf-field">
                    <span>默认文件</span>
                    <WorkflowValue
                      field={field}
                      fileDirectory="constants"
                      value={field.defaultValue}
                      onChange={(defaultValue) =>
                        update(index, { defaultValue })
                      }
                    />
                  </div>
                )}
              {defaults &&
                !system.has(index) &&
                ["string", "integer", "float", "boolean"].includes(
                  field.type,
                ) &&
                !field.multiple && (
                  <label className="wf-field">
                    默认值
                    {field.enumValues ? (
                      <SearchSelect
                        ariaLabel={`${field.name} 默认值`}
                        value={String(field.enumValues.findIndex(
                          (v) => v === field.defaultValue,
                        ))}
                        onChange={(next) => update(index, {
                            defaultValue:
                              field.enumValues![Number(next)],
                          })}
                        options={[
                          { value: String(-1), label: "不设置" },
                          ...field.enumValues.map((value, i) => ({ value: String(i), label: String(value) })),
                        ]}
                      />
                    ) : field.type === "boolean" ? (
                      <SearchSelect
                        ariaLabel="默认值"
                        value={
                          field.defaultValue === undefined
                            ? "unset"
                            : String(field.defaultValue)
                        }
                        onChange={(next) => update(index, {
                            defaultValue:
                              next === "unset"
                                ? undefined
                                : next === "true",
                          })}
                        options={[
                          { value: "unset", label: "不设置" },
                          { value: "true", label: "true" },
                          { value: "false", label: "false" },
                        ]}
                      />
                    ) : (
                      <input
                        type={field.type === "string" ? "text" : "number"}
                        value={
                          field.defaultValue === undefined
                            ? ""
                            : String(field.defaultValue)
                        }
                        placeholder="不设置"
                        onChange={(e) =>
                          update(index, {
                            defaultValue:
                              e.target.value === ""
                                ? undefined
                                : field.type === "string"
                                  ? e.target.value
                                  : Number(e.target.value),
                          })
                        }
                      />
                    )}
                  </label>
                )}
            </>
          )}
        </section>
      ))}
      <Button
        type="button"
        className="wf-button"
        onClick={() => {
          // 删除、改名后的序号可能已被占用，新参数始终使用未占用名称。
          let number = fields.length + 1;
          while (
            fields.some((field) => field.name === `param_${number}`) ||
            reserved.includes(`param_${number}`)
          )
            number++;
          onChange([...fields, { name: `param_${number}`, type: "string" }]);
        }}
      >
        <Plus size={15} />
        添加参数
      </Button>
    </div>
  );
}

/** 枚举用索引表达选项，避免数字、布尔值经过 DOM 后丢失真实类型。 */
function WorkflowEnumValue({
  field,
  value,
  onChange,
  onValidity,
}: {
  field: WorkflowInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
}) {
  const options = field.enumValues!;
  const selected = options.findIndex((option) => option === value);
  const entries = field.multiple && Array.isArray(value) ? value : [];
  const valid =
    (value === undefined && !field.required) ||
    (field.multiple
      ? Array.isArray(value) &&
        entries.every((v) => options.includes(v as string))
      : selected >= 0);
  useEffect(() => {
    onValidity?.(valid);
  }, [valid, JSON.stringify(options)]);
  useEffect(() => () => onValidity?.(true), []);
  const choices = options.map((option, index) => ({
    value: index,
    label: options.some((other) => other !== option && String(other) === String(option))
      ? `${String(option)} · ${typeof option}`
      : String(option),
  }));
  const unavailable = value === undefined
    ? "请选择枚举值"
    : "当前值已不在枚举范围内，请重新选择";
  return (
    <>
      {field.multiple ? (
        <div role="group" aria-label={field.name} aria-invalid={!valid}>
          {choices.map(({ value: index, label }) => (
            <Checkbox key={index} label={label} checked={entries.includes(options[index])}
              onChange={(event) => {
                // 按接口枚举顺序提交选项，并允许修正已经失效的旧值。
                onChange(options.filter((option, position) => position === index
                  ? event.currentTarget.checked
                  : entries.includes(option)));
              }}
            />
          ))}
        </div>
      ) : (
        <SearchSelect ariaLabel={field.name} aria-invalid={!valid} value={selected}
          placeholder={unavailable} options={choices}
          onChange={(index) => onChange(options[index])}
        />
      )}
      {!valid && <small className="wf-error">请选择接口允许的枚举值。</small>}
    </>
  );
}

/** 移除仅更新当前参数引用，保留历史运行及其他字段共用的资产。 */
export function WorkflowSelectedFiles({
  field,
  value,
  mediaNames,
  disabled,
  onChange,
}: {
  field: WorkflowInputField;
  value: unknown;
  mediaNames?: Readonly<Record<string, string>>;
  disabled: boolean;
  onChange: (value: unknown) => void;
}) {
  const entries = (Array.isArray(value) ? value : value ? [value] : []).filter(
    (item): item is WorkflowFile | string => isMediaReference(item) || (!!item && typeof item.assetId === "string"),
  );
  if (!entries.length) return null;
  return (
    <ul className="wf-selected-files" aria-label={`已选择的文件 ${field.name}`}>
      {entries.map((file, index) => {
        const id = typeof file === "string" ? file : file.assetId;
        const name = typeof file === "string" ? mediaNames?.[file] ?? "媒体库文件" : file.name;
        return <li key={`${id}-${index}`}>
          <span>{name}</span>
          <Button
            type="button"
            className="wf-button"
            disabled={disabled}
            aria-label={`移除 ${name}`}
            onClick={() => {
              // 单文件显式提交空值，防止服务端再次填回已移除的默认文件。
              onChange(field.multiple
                ? entries.filter((_, current) => current !== index)
                : null);
            }}
          >
            移除
          </Button>
        </li>;
      })}
    </ul>
  );
}

/** 媒体固定值上传到受控资产目录，输入中只保存文件引用。 */
function WorkflowMediaValue({
  directory,
  field,
  value,
  onChange,
  onValidity,
}: {
  field: WorkflowInputField;
  value: unknown;
  onChange: (value: unknown) => void;
  onValidity?: (valid: boolean) => void;
  directory: "runtime" | "constants";
}) {
  const { runApiTask } = useApiTask();
  const [choosing, setChoosing] = useState(false);
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const latest = useRef(onChange);
  latest.current = onChange;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const entries = (
    Array.isArray(value) ? value : value ? [value] : []
  ) as WorkflowFile[];
  const valid =
    entries.length > 0 &&
    entries.every(
      (item) =>
        item &&
        typeof item.assetId === "string" &&
        typeof item.mediaType === "string" &&
        (field.type === "file" || item.mediaType.startsWith(`${field.type}/`)),
    );
  useEffect(() => {
    onValidity?.(valid && !busy);
  }, [valid, busy]);
  useEffect(() => () => onValidity?.(true), []);
  return (
    <>
      <FilePickerButton
        label={`上传 ${field.name}`}
        multiple={field.multiple}
        disabled={busy}
        accept={field.type === "file" ? undefined : `${field.type}/*`}
        onFilesSelected={(selected) => {
          setBusy(true);
          void runApiTask(
            async () => {
              const existing = field.multiple ? entries : [];
              if (existing.length + selected.length > (field.maxItems ?? 100))
                throw new Error(
                  `参数 ${field.name} 最多上传 ${field.maxItems ?? 100} 个文件`,
                );
              const files = await Promise.all(
                selected.map((file) => directory === "constants" ? api.uploadWorkflowFile(file, directory) : api.uploadWorkflowFile(file)),
              );
              // 上传期间切换来源或节点后不回写；同节点其他修改使用最新回调保留。
              if (mounted.current)
                latest.current(
                  field.multiple ? [...existing, ...files] : files[0],
                );
            },
            { operation: `上传工作流参数 ${field.name}` },
          ).finally(() => {
            if (mounted.current) setBusy(false);
          });
        }}
      >选择本地文件</FilePickerButton>
      {directory === "constants" && <Button type="button" className="wf-button" disabled={busy} onClick={() => setChoosing(true)}>选择已有文件常量</Button>}
      {choosing && <WorkflowFilePicker type={field.type} onClose={() => setChoosing(false)} onSelect={(file) => {
        void runApiTask(async () => {
          if (field.multiple && entries.length + 1 > (field.maxItems ?? 100)) throw new Error(`参数 ${field.name} 最多选择 ${field.maxItems ?? 100} 个文件`);
          onChange(field.multiple ? [...entries, file] : file);
          setChoosing(false);
        }, {operation: "选择文件常量"});
      }}/>}
      <WorkflowSelectedFiles
        field={field}
        value={value}
        disabled={busy}
        onChange={onChange}
      />
      {(busy || !valid) && (
        <small>{busy ? "正在上传…" : "请选择媒体文件，或改用上游节点输出。"}</small>
      )}
    </>
  );
}

/** 根据完整字段定义创建固定值，优先使用接口默认值和真实枚举选项。 */
function initialLiteral(field: WorkflowInputField): unknown {
  if (field.defaultValue !== undefined) return field.defaultValue;
  if (field.multiple) return [];
  if (field.enumValues?.length) return field.enumValues[0];
  if (field.type === "boolean") return false;
  if (field.type === "integer" || field.type === "float") return field.min ?? 0;
  if (
    field.type === "object" ||
    ["image", "video", "audio", "file"].includes(field.type)
  )
    return {};
  return "";
}

/** 引用通过稳定节点 ID 保存；有声明的输入类型只读，自由输入才允许选类型。 */
export function WorkflowBindingEditor({
  label,
  binding,
  nodes,
  nodeId,
  onChange,
  type = "string",
  field,
  onValidity,
  referenceOnly = false,
}: {
  label: string;
  binding?: WorkflowBinding;
  nodes: WorkflowNode[];
  nodeId: string;
  onChange: (binding: WorkflowBinding | undefined) => void;
  type?: WorkflowField["type"];
  field?: WorkflowInputField;
  referenceOnly?: boolean;
  onValidity?: (valid: boolean) => void;
}) {
  const [constantType, setConstantType] = useState<WorkflowField["type"]>(() =>
    binding?.kind === "literal"
      ? typeof binding.value === "boolean"
        ? "boolean"
        : typeof binding.value === "number"
          ? "float"
          : typeof binding.value === "object"
            ? "object"
            : type
      : type,
  );
  const effective = field ?? { name: label, type: constantType };
  const selection =
    binding?.kind === "reference"
      ? `${binding.nodeId}:${binding.field}`
      : binding
        ? "literal"
        : "unset";
  const available = nodes
    .filter((node) => node.id !== nodeId && node.kind !== "output")
    .map((node) => ({
      ...node,
      outputs: node.outputs.filter(
        (output) =>
          !referenceOnly ||
          (output.type === field?.type &&
            !!output.multiple === !!field?.multiple),
      ),
    }));
  const missing =
    binding?.kind === "reference" &&
    !available.some(
      (node) =>
        node.id === binding.nodeId &&
        node.outputs.some((output) => output.name === binding.field),
    );
  return (
    <section className="wf-binding" aria-label={`${label} 参数配置`}>
      <div className="wf-parameter-heading">
        <strong>{label}</strong>
        {field && (
          <span className="wf-type-badge">
            {field.enumValues?.length ? "枚举 · " : ""}
            {field.type}
            {field.multiple ? "[]" : ""}
          </span>
        )}
      </div>
      {field?.description && <p className="wf-hint">{field.description}</p>}
      <label className="wf-field">
        值来源
        <SearchSelect
          ariaLabel={`${label} 值来源`}
          value={selection}
          onChange={(next) => {
            if (next === "unset") onChange(undefined);
            else if (next === "literal")
              onChange({ kind: "literal", value: initialLiteral(effective) });
            else {
              const [source, name] = next.split(":");
              onChange({ kind: "reference", nodeId: source, field: name });
            }
          }}
          options={[
            { value: "unset", label: field?.defaultValue !== undefined ? "使用接口默认值" : "不提供" },
            ...(!referenceOnly ? [{ value: "literal", label: "固定值" }] : []),
            ...(missing ? [{ value: selection, label: "引用已失效，请重新选择", disabled: true }] : []),
            ...available.flatMap((node) => node.outputs.map((output) => ({ value: `${node.id}:${output.name}`, label: `${node.name} / ${output.name} · ${output.type}${output.multiple ? "[]" : ""}` }))),
          ]}
        />
      </label>
      {binding?.kind === "literal" && (
        <>
          {!field && (
            <label className="wf-field">
              数据类型
              <SearchSelect
                ariaLabel={`${label} 常量类型`}
                value={constantType}
                onChange={(next) => {
                  const nextType = next as WorkflowField["type"];
                  setConstantType(nextType);
                  onChange({
                    kind: "literal",
                    value: initialLiteral({ name: label, type: nextType }),
                  });
                }}
                options={["string", "float", "integer", "boolean", "object"].map((t) => ({ value: t, label: t }))}
              />
            </label>
          )}
          <div className="wf-field">
            <span>参数值</span>
            <WorkflowValue
              fileDirectory="constants"
              field={effective}
              value={binding.value}
              onChange={(value) => onChange({ kind: "literal", value })}
              onValidity={onValidity}
            />
          </div>
        </>
      )}
      {binding?.kind === "reference" && field?.enumValues?.length ? (
        <p className="wf-hint">
          上游值按字符串匹配枚举，转换失败将停止并报错。
        </p>
      ) : null}
      {field?.defaultValue !== undefined && !binding && (
        <small className="wf-hint">
          默认值：{JSON.stringify(field.defaultValue)}
        </small>
      )}
    </section>
  );
}
