import { Button } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { SearchSelect } from "../ui/search-select";
import { ArrowLeft, Check, GitBranch, GripVertical, Layers3, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  AigcWorkflowDetail,
  AigcWorkflowInputGroup,
  AigcWorkflowInputMapping,
  AigcWorkflowInputType,
  AigcWorkflowOutputMapping,
  ComfyUiEdge,
  ComfyUiField,
  ComfyUiFieldMetadata,
  ComfyUiNode,
} from "../../shared/aigc-contracts";
import { commonReferenceInputFields, referenceInputFamilies, traceReferenceInputBranches } from "../../shared/aigc-reference-input-groups";
import { ConfirmDialog } from "../ui/dialog";
import "../aigc-workflow-composer.css";

interface AigcWorkflowComposerProps {
  workflow: AigcWorkflowDetail;
  name: string;
  onNameChange: (name: string) => void;
  inputMappings: AigcWorkflowInputMapping[];
  inputGroups?: AigcWorkflowInputGroup[];
  outputMappings: AigcWorkflowOutputMapping[];
  onInputMappingsChange: (mappings: AigcWorkflowInputMapping[]) => void;
  onInputGroupsChange?: (groups: AigcWorkflowInputGroup[]) => void;
  onOutputMappingsChange: (mappings: AigcWorkflowOutputMapping[]) => void;
}

/** ComfyUI 工作流可视化编排器，使用拓扑关系区分浏览节点与映射目标。 */
export function AigcWorkflowComposer(props: AigcWorkflowComposerProps) {
  const { workflow, name, onNameChange, inputMappings, inputGroups = [], outputMappings, onInputMappingsChange, onInputGroupsChange = () => undefined, onOutputMappingsChange } = props;

  return (
    <div className="aigc-workflow-composer">
      <section className="configuration-form-card aigc-config-section aigc-workflow-summary">
        <div className="configuration-section__heading">
          <div><span>01</span><h2>工作流信息</h2></div>
          <small title={workflow.fileName}>{workflow.fileName}</small>
        </div>
        <label><span>名称</span><input aria-label="工作流名称" value={name} onChange={(event) => onNameChange(event.target.value)} /></label>
        <div className="aigc-workflow-stats">
          <span>{workflow.nodes.length} 个节点</span>
          <span>{workflow.edges.length} 条连线</span>
          <span>{inputMappings.length} 个入参</span>
          <span>{outputMappings.length} 个输出</span>
        </div>
      </section>

      <InputMappingBuilder workflow={workflow} mappings={inputMappings} groups={inputGroups} onChange={onInputMappingsChange} onGroupsChange={onInputGroupsChange} />
      <OutputMappingBuilder workflow={workflow} mappings={outputMappings} onChange={onOutputMappingsChange} />
    </div>
  );
}

/** 入参映射编辑区。 */
function InputMappingBuilder(props: {
  workflow: AigcWorkflowDetail;
  mappings: AigcWorkflowInputMapping[];
  groups: AigcWorkflowInputGroup[];
  onChange: (mappings: AigcWorkflowInputMapping[]) => void;
  onGroupsChange: (groups: AigcWorkflowInputGroup[]) => void;
}) {
  const { workflow, mappings, groups, onChange, onGroupsChange } = props;
  const [draft, setDraft] = useState<AigcWorkflowInputMapping>();
  const [browseNodeId, setBrowseNodeId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [defaultValueDraft, setDefaultValueDraft] = useState("");
  const [defaultValueError, setDefaultValueError] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AigcWorkflowInputMapping>();
  const [deleteGroupTarget, setDeleteGroupTarget] = useState<AigcWorkflowInputGroup>();
  const [groupDraft, setGroupDraft] = useState<ReferenceGroupDraft>();
  const [groupError, setGroupError] = useState("");
  const [draggedItemId, setDraggedItemId] = useState("");
  const selectedNode = workflow.nodes.find((node) => node.id === draft?.nodeId);
  const selectedFields = selectedNode ? inputFields(selectedNode) : [];
  const blockedActivationNodeIds = useMemo(() => new Set(
    mappings
      .filter((mapping) => mapping.id !== editingId)
      .flatMap((mapping) => mapping.activation?.nodeIds ?? []),
  ), [editingId, mappings]);
  const listItems = useMemo(() => inputListItems(mappings, groups), [groups, mappings]);
  function beginGroup() {
    setGroupDraft({ boundaryNodeId: "", targetFieldPrefix: "", label: "参考素材", namePrefix: "reference", type: "image", field: "" });
    setGroupError("");
  }

  function updateGroupDraft(patch: Partial<ReferenceGroupDraft>) {
    setGroupDraft((current) => current ? { ...current, ...patch } : current);
    setGroupError("");
  }

  function commitGroup() {
    if (!groupDraft) return;
    try {
      const branches = traceReferenceInputBranches(workflow, groupDraft.boundaryNodeId, groupDraft.targetFieldPrefix);
      const fields = commonReferenceInputFields(workflow, branches);
      const field = groupDraft.field || (fields.length === 1 ? fields[0] : "");
      if (!groupDraft.label.trim() || !groupDraft.namePrefix.trim() || !field || !branches.length) {
        setGroupError("请完整选择汇总节点、接口、输入字段并填写组名称和参数前缀");
        return;
      }
      const occupied = new Set(groups.flatMap((group) => group.mappingIds));
      const reusedIds = new Set<string>();
      const members = branches.map((branch, index) => {
        const existing = mappings.find((mapping) => mapping.nodeId === branch.rootNodeId && !occupied.has(mapping.id) && !reusedIds.has(mapping.id));
        const id = existing?.id ?? crypto.randomUUID();
        reusedIds.add(id);
        return {
          ...(existing ?? {}),
          id,
          name: existing?.name ?? uniqueMappingName(`${groupDraft.namePrefix.trim()}_${index + 1}`, mappings),
          nodeId: branch.rootNodeId,
          field,
          type: groupDraft.type,
          required: false,
          activation: { when: "provided" as const, nodeIds: [...branch.activationNodeIds] },
        } satisfies AigcWorkflowInputMapping;
      });
      // 组成员必须连续，汇总接口顺序就是运行时槽位顺序。
      onChange([...mappings.filter((mapping) => !reusedIds.has(mapping.id)), ...members]);
      onGroupsChange([...groups, {
        id: crypto.randomUUID(),
        label: groupDraft.label.trim(),
        type: groupDraft.type,
        mappingIds: members.map((mapping) => mapping.id),
        boundaryNodeId: groupDraft.boundaryNodeId,
        targetFieldPrefix: groupDraft.targetFieldPrefix,
      }]);
      setGroupDraft(undefined);
    } catch (error) {
      setGroupError(error instanceof Error ? error.message : "无法识别参考输入分支");
    }
  }

  function moveInputItem(targetItemId: string) {
    if (!draggedItemId || draggedItemId === targetItemId) return;
    onChange(reorderInputMappings(mappings, groups, draggedItemId, targetItemId));
    setDraggedItemId("");
  }

  function beginAdd() {
    setDraft({
      id: "",
      name: "",
      nodeId: "",
      field: "",
      type: "string",
      required: true,
      enumOptions: [],
      defaultValue: undefined,
      description: "",
    });
    setBrowseNodeId("");
    setEditingId("");
    setDefaultValueDraft("");
    setDefaultValueError("");
  }

  function beginEdit(mapping: AigcWorkflowInputMapping) {
    setDraft(cloneInputMapping(mapping));
    setBrowseNodeId(mapping.nodeId);
    setEditingId(mapping.id);
    setDefaultValueDraft(inputDefaultValueDraft(mapping));
    setDefaultValueError("");
  }

  function selectMappingNode(nodeId: string) {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    const firstField = node ? inputFields(node)[0] : undefined;
    const metadata = node && firstField ? fieldMetadata(workflow, node, firstField.name) : undefined;
    setDraft((current) => current ? {
      ...current,
      name: current.name || (firstField ? parameterNameFromField(firstField) : ""),
      nodeId,
      field: firstField?.name ?? "",
      type: metadata?.valueType ?? firstField?.valueType ?? current.type,
      enumOptions: metadata?.enumOptions ? [...metadata.enumOptions] : undefined,
      ...(current.defaultValue === undefined && metadata?.defaultValue !== undefined ? { defaultValue: metadata.defaultValue } : {}),
      ...(current.activation ? { activation: { when: "provided", nodeIds: [nodeId] } } : {}),
    } : current);
    if (metadata?.defaultValue !== undefined) setDefaultValueDraft(defaultValueDraftFromScalar(metadata.defaultValue, metadata.valueType));
    setDefaultValueError("");
  }

  function selectField(field: ComfyUiField) {
    const metadata = selectedNode ? fieldMetadata(workflow, selectedNode, field.name) : undefined;
    setDraft((current) => current ? {
      ...current,
      field: field.name,
      type: metadata?.valueType ?? field.valueType ?? current.type,
      enumOptions: metadata?.enumOptions ? [...metadata.enumOptions] : undefined,
      ...(metadata?.defaultValue !== undefined ? { defaultValue: metadata.defaultValue } : {}),
    } : current);
    setDefaultValueDraft(metadata?.defaultValue === undefined ? "" : defaultValueDraftFromScalar(metadata.defaultValue, metadata.valueType));
    setDefaultValueError("");
  }

  function updateDraft<K extends keyof AigcWorkflowInputMapping>(key: K, value: AigcWorkflowInputMapping[K]) {
    setDraft((current) => current ? { ...current, [key]: value } : current);
  }

  function changeInputType(type: AigcWorkflowInputType) {
    const metadata = selectedNode ? fieldMetadata(workflow, selectedNode, draft?.field ?? "") : undefined;
    setDraft((current) => current ? {
      ...current,
      type,
      enumOptions: type === "enum" && metadata?.enumOptions ? [...metadata.enumOptions] : current.enumOptions,
    } : current);
    setDefaultValueError("");
  }

  function toggleActivation(enabled: boolean) {
    setDraft((current) => {
      if (!current) return current;
      if (!enabled) {
        const { activation: _activation, ...next } = current;
        return next;
      }
      return {
        ...current,
        required: false,
        activation: { when: "provided", nodeIds: current.nodeId ? [current.nodeId] : [] },
      };
    });
  }

  function changeActivationNodeIds(nodeIds: string[]) {
    setDraft((current) => current?.activation ? { ...current, activation: { ...current.activation, nodeIds } } : current);
  }

  function closeEditor() {
    setDraft(undefined);
    setBrowseNodeId("");
    setEditingId("");
    setDefaultValueDraft("");
    setDefaultValueError("");
  }

  function commit() {
    if (!draft || !draft.name.trim() || !draft.nodeId || !draft.field) return;
    if (draft.activation && draft.activation.nodeIds.length === 0) return;
    const selectedMetadata = selectedNode ? fieldMetadata(workflow, selectedNode, draft.field) : undefined;
    const conflict = metadataConflict(selectedMetadata);
    if (conflict) {
      setDefaultValueError(conflict);
      return;
    }
    const enumOptions = draft.type === "enum" ? effectiveEnumOptions(draft, selectedMetadata) : undefined;
    if (draft.type === "enum" && !enumOptions?.length) {
      setDefaultValueError("枚举参数必须至少包含一个候选值");
      return;
    }
    const parsedDefault = parseDefaultValueDraft(draft.type, defaultValueDraft, enumOptions);
    if (parsedDefault.error) {
      setDefaultValueError(parsedDefault.error);
      return;
    }
    const constraintError = defaultValueConstraintError(parsedDefault.value, draft.type, selectedMetadata, enumOptions);
    if (constraintError) {
      setDefaultValueError(constraintError);
      return;
    }
    const { defaultValue: _defaultValue, enumOptions: _enumOptions, ...draftWithoutDefault } = draft;
    const normalized = cloneInputMapping({
      ...draftWithoutDefault,
      name: draft.name.trim(),
      ...(enumOptions?.length ? { enumOptions: [...enumOptions] } : {}),
      ...(parsedDefault.value !== undefined ? { defaultValue: parsedDefault.value } : {}),
    });
    if (editingId) onChange(mappings.map((mapping) => mapping.id === editingId ? { ...normalized, id: editingId } : mapping));
    else onChange([...mappings, { ...normalized, id: crypto.randomUUID() }]);
    closeEditor();
  }

  return (
    <section className="configuration-form-card aigc-config-section">
      <div className="configuration-section__heading">
        <div><span>02</span><h2>入参映射</h2></div>
        <div className="aigc-section-actions">
          <Button type="button" className="configuration-secondary-action" onClick={beginGroup}><Layers3 size={15} />创建参考组</Button>
          <Button variant="primary" type="button" className="configuration-primary-action" onClick={beginAdd}><Plus size={15} />新增入参</Button>
        </div>
      </div>
      <p className="configuration-help">浏览节点关系后明确选择映射目标；可选参数还可以按是否有值启用一组条件节点。</p>

      {mappings.length ? (
        <div className="aigc-mapping-list">
          {listItems.map((item) => {
            if (item.kind === "group") {
              const group = item.group;
              return (
                <article key={group.id} className="aigc-task-row aigc-mapping-card aigc-mapping-card--group" draggable onDragStart={() => setDraggedItemId(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveInputItem(item.id)}>
                  <button type="button" className="aigc-drag-handle" aria-label={`拖动调整${group.label}顺序`} title="拖动调整顺序"><GripVertical size={16} /></button>
                  <div className="aigc-mapping-card__main">
                    <strong>{group.label}</strong>
                    <span>{group.type} · {group.mappingIds.length} 个槽位</span>
                    <small>汇总节点 #{group.boundaryNodeId} · {group.targetFieldPrefix}</small>
                  </div>
                  <div className="aigc-task-actions">
                    <button type="button" className="is-danger" onClick={() => setDeleteGroupTarget(group)}><Trash2 size={14} />删除</button>
                  </div>
                </article>
              );
            }
            const mapping = item.mapping;
            const node = workflow.nodes.find((item) => item.id === mapping.nodeId);
            return (
              <article key={mapping.id} className="aigc-task-row aigc-mapping-card" draggable onDragStart={() => setDraggedItemId(item.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveInputItem(item.id)}>
                <button type="button" className="aigc-drag-handle" aria-label={`拖动调整${mapping.name}顺序`} title="拖动调整顺序"><GripVertical size={16} /></button>
                <div className="aigc-mapping-card__main">
                  <strong>{mapping.name}</strong>
                  <span title={`${nodeLabel(node, mapping.nodeId)} · ${mapping.field}`}>{nodeLabel(node, mapping.nodeId)} · {mapping.field}</span>
                  <small>{mapping.type}{mapping.required ? " · 必填" : " · 可选"}{mapping.activation ? ` · 条件分支 ${mapping.activation.nodeIds.length} 节点` : ""}</small>
                </div>
                <div className="aigc-task-actions">
                  <button type="button" onClick={() => beginEdit(mapping)}><Pencil size={14} />编辑</button>
                  <button type="button" className="is-danger" onClick={() => setDeleteTarget(mapping)}><Trash2 size={14} />删除</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="configuration-help">还没有入参映射。工作流执行时可只使用固定节点值。</p>}

      {draft ? (
        <div className="aigc-mapping-editor">
          <div className="configuration-section__heading">
            <strong>{editingId ? "编辑入参" : "新增入参"}</strong>
            <button type="button" className="icon-button" aria-label="关闭入参编辑" onClick={closeEditor}><X size={15} /></button>
          </div>

          <div className="aigc-mapping-workspace">
            <WorkflowNodeNavigator
              workflow={workflow}
              browseNodeId={browseNodeId}
              mappingNodeId={draft.nodeId}
              mappingKind="input"
              activationNodeIds={draft.activation?.nodeIds}
              blockedActivationNodeIds={blockedActivationNodeIds}
              onBrowseNodeChange={setBrowseNodeId}
              onSelectMappingNode={selectMappingNode}
              onActivationNodeIdsChange={changeActivationNodeIds}
            />

            <div className="aigc-mapping-config">
              <MappingTargetSummary node={selectedNode} nodeId={draft.nodeId} field={draft.field} />
              <div className="aigc-fieldset">
                <div className="aigc-fieldset__heading"><strong>映射字段</strong><small>字段来自已选择的映射目标，不随浏览节点变化</small></div>
                <div className="aigc-field-picker">
                  {selectedFields.map((field) => (
                    <button type="button" key={field.name} className={draft.field === field.name ? "is-selected" : undefined} onClick={() => selectField(field)}>
                      <strong title={field.name}>{fieldLabel(field)}</strong><small>{fieldMetadataSummary(fieldMetadata(workflow, selectedNode, field.name)) ?? field.valueType ?? field.kind}</small>
                    </button>
                  ))}
                  {!draft.nodeId ? <p className="configuration-help">请先从左侧将一个节点选为映射节点。</p> : null}
                  {draft.nodeId && !selectedFields.length ? <p className="configuration-help">该节点没有可映射的输入字段。</p> : null}
                </div>
              </div>

              <div className="aigc-fieldset">
                <div className="aigc-fieldset__heading"><strong>参数配置</strong><small>定义工作流入参对外暴露的名称和数据类型</small></div>
                <div className="aigc-form-grid">
                  <label><span>参数名</span><input aria-label="入参名称" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
                  <label><span>类型</span><SearchSelect
                    ariaLabel="入参类型"
                    value={draft.type}
                    onChange={(next) => changeInputType(next as AigcWorkflowInputType)}
                    options={inputTypeOptions.map((option) => ({ value: option.value, label: option.label }))}
                  /></label>
                  <DefaultValueField mapping={draft} metadata={selectedNode ? fieldMetadata(workflow, selectedNode, draft.field) : undefined} value={defaultValueDraft} error={defaultValueError} onChange={(value) => { setDefaultValueDraft(value); setDefaultValueError(""); }} />
                  <label className="configuration-check-line aigc-check-cell"><Checkbox checked={draft.required} disabled={Boolean(draft.activation)} onChange={(event) => updateDraft("required", event.target.checked)} /><span>必填</span></label>
                  <label className="aigc-span-2"><span>说明</span><input aria-label="入参说明" value={draft.description ?? ""} onChange={(event) => updateDraft("description", event.target.value)} /></label>
                  {draft.type === "enum" && !fieldMetadata(workflow, selectedNode, draft.field)?.enumOptions ? <label className="aigc-span-2"><span>枚举选项</span><textarea aria-label="枚举选项" rows={3} value={(draft.enumOptions ?? []).join("\n")} onChange={(event) => updateDraft("enumOptions", event.target.value.split("\n").map((item) => item.trim()).filter(Boolean))} /></label> : null}
                </div>
                <label className="configuration-check-line aigc-activation-toggle">
                  <Checkbox aria-label="有值时启用分支" checked={Boolean(draft.activation)} disabled={!draft.nodeId} onChange={(event) => toggleActivation(event.target.checked)} />
                  <span><strong>有值时启用分支</strong><small>没有填写该参数时，提交前删除左侧勾选的节点组</small></span>
                </label>
              </div>
            </div>
          </div>

          <div className="configuration-save-bar">
            <Button type="button" className="configuration-secondary-action" onClick={closeEditor}>取消</Button>
            <Button variant="primary" type="button" className="configuration-primary-action" disabled={!draft.name.trim() || !draft.nodeId || !draft.field || Boolean(draft.activation && draft.activation.nodeIds.length === 0)} onClick={commit}><Check size={15} />{editingId ? "保存修改" : "添加映射"}</Button>
          </div>
        </div>
      ) : null}
      {groupDraft ? <ReferenceGroupEditor workflow={workflow} draft={groupDraft} error={groupError} onChange={updateGroupDraft} onCancel={() => setGroupDraft(undefined)} onCommit={commitGroup} /> : null}
      {deleteTarget ? <ConfirmDialog title={`删除入参“${deleteTarget.name}”？`} description="删除后该参数将不再写入 ComfyUI 节点；关联的条件分支配置也会一并删除。" confirmLabel="删除入参" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => { onChange(mappings.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(undefined); }} /> : null}
      {deleteGroupTarget ? <ConfirmDialog title={`删除参考组“${deleteGroupTarget.label}”？`} description="删除后该组及其底层入参映射会一并移除。" confirmLabel="删除参考组" onCancel={() => setDeleteGroupTarget(undefined)} onConfirm={() => { const ids = new Set(deleteGroupTarget.mappingIds); onChange(mappings.filter((item) => !ids.has(item.id))); onGroupsChange(groups.filter((item) => item.id !== deleteGroupTarget.id)); setDeleteGroupTarget(undefined); }} /> : null}
    </section>
  );
}

interface ReferenceGroupDraft {
  boundaryNodeId: string;
  targetFieldPrefix: string;
  label: string;
  namePrefix: string;
  type: AigcWorkflowInputGroup["type"];
  field: string;
}

/** 参考组向导只依据用户选择和工作流拓扑，不推断素材语义。 */
function ReferenceGroupEditor({ workflow, draft, error, onChange, onCancel, onCommit }: {
  workflow: AigcWorkflowDetail;
  draft: ReferenceGroupDraft;
  error: string;
  onChange: (patch: Partial<ReferenceGroupDraft>) => void;
  onCancel: () => void;
  onCommit: () => void;
}) {
  const [boundaryQuery, setBoundaryQuery] = useState("");
  const boundaries = workflow.nodes.filter((node) => referenceInputFamilies(workflow, node.id).length > 0);
  const normalizedBoundaryQuery = boundaryQuery.trim().toLocaleLowerCase();
  const filteredBoundaries = boundaries.filter((node) => !normalizedBoundaryQuery || [node.id, node.title ?? "", node.type]
    .some((value) => value.toLocaleLowerCase().includes(normalizedBoundaryQuery)));
  const selectedBoundary = boundaries.find((node) => node.id === draft.boundaryNodeId);
  // 搜索期间保留当前选择，避免原生 select 因选项暂时被过滤而显示空值。
  const boundaryOptions = selectedBoundary && !filteredBoundaries.some((node) => node.id === selectedBoundary.id)
    ? [selectedBoundary, ...filteredBoundaries]
    : filteredBoundaries;
  const families = referenceInputFamilies(workflow, draft.boundaryNodeId);
  const result = referenceGroupPreview(workflow, draft.boundaryNodeId, draft.targetFieldPrefix);
  const field = draft.field || (result.fields.length === 1 ? result.fields[0] : "");
  return (
    <div className="aigc-mapping-editor aigc-reference-group-editor">
      <div className="configuration-section__heading"><strong>创建参考输入组</strong><button type="button" className="icon-button" aria-label="关闭参考组编辑" onClick={onCancel}><X size={15} /></button></div>
      <div className="aigc-form-grid">
        <div className="aigc-config-field aigc-span-2 aigc-reference-boundary-picker"><span>汇总节点</span>
          <div className="aigc-node-search aigc-reference-node-search">
            <Search size={14} aria-hidden="true" />
            <input type="search" aria-label="搜索参考组汇总节点" placeholder="搜索节点标题、类型或 ID" value={boundaryQuery} onChange={(event) => setBoundaryQuery(event.target.value)} />
            <small>{filteredBoundaries.length}/{boundaries.length}</small>
          </div>
          <SearchSelect
            ariaLabel="参考组汇总节点"
            value={draft.boundaryNodeId}
            onChange={(next) => { const boundaryNodeId = next; setBoundaryQuery(""); onChange({ boundaryNodeId, targetFieldPrefix: referenceInputFamilies(workflow, boundaryNodeId)[0]?.prefix ?? "", field: "" }); }}
            options={[
              { value: "", label: normalizedBoundaryQuery && !filteredBoundaries.length ? "没有匹配的节点" : "请选择节点" },
              ...boundaryOptions.map((node) => ({ value: node.id, label: referenceBoundaryLabel(node) })),
            ]}
          />
        </div>
        <label><span>汇总接口</span><SearchSelect
          ariaLabel="参考组汇总接口"
          value={draft.targetFieldPrefix}
          onChange={(next) => onChange({ targetFieldPrefix: next, field: "" })}
          options={[
            { value: "", label: "请选择接口" },
            ...families.map((family) => ({ value: family.prefix, label: `${family.prefix} (${family.targetFields.length})` })),
          ]}
        /></label>
        <label><span>组名称</span><input aria-label="参考组名称" value={draft.label} onChange={(event) => onChange({ label: event.target.value })} /></label>
        <label><span>参数前缀</span><input aria-label="参考组参数前缀" value={draft.namePrefix} onChange={(event) => onChange({ namePrefix: event.target.value })} /></label>
        <label><span>用户输入类型</span><SearchSelect
          ariaLabel="参考组输入类型"
          value={draft.type}
          onChange={(next) => onChange({ type: next as ReferenceGroupDraft["type"] })}
          options={[
            { value: "image", label: "图片" },
            { value: "video", label: "视频" },
            { value: "audio", label: "音频" },
          ]}
        /></label>
        <label><span>根节点输入字段</span><SearchSelect
          ariaLabel="参考组输入字段"
          value={field}
          onChange={(next) => onChange({ field: next })}
          options={[
            { value: "", label: "请选择字段" },
            ...result.fields.map((candidate) => ({ value: candidate, label: candidate })),
          ]}
        /></label>
      </div>
      {result.error ? <p className="aigc-field-error" role="alert">{result.error}</p> : null}
      {!result.error && result.branches.length ? <div className="aigc-reference-preview"><strong>{result.branches.length} 个参考槽位</strong><span>按汇总接口顺序固定</span><small>{result.branches.map((branch) => `#${branch.rootNodeId}（${branch.activationNodeIds.length} 节点）`).join(" · ")}</small></div> : null}
      {error ? <p className="aigc-field-error" role="alert">{error}</p> : null}
      <div className="configuration-save-bar"><Button type="button" className="configuration-secondary-action" onClick={onCancel}>取消</Button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!draft.boundaryNodeId || !draft.targetFieldPrefix || !draft.label.trim() || !draft.namePrefix.trim() || !field || Boolean(result.error)} onClick={() => { if (!draft.field && field) onChange({ field }); onCommit(); }}><Check size={15} />创建参考组</Button></div>
    </div>
  );
}

/** 输出映射编辑区。 */
function OutputMappingBuilder(props: {
  workflow: AigcWorkflowDetail;
  mappings: AigcWorkflowOutputMapping[];
  onChange: (mappings: AigcWorkflowOutputMapping[]) => void;
}) {
  const { workflow, mappings, onChange } = props;
  const [draft, setDraft] = useState<AigcWorkflowOutputMapping>();
  const [browseNodeId, setBrowseNodeId] = useState("");
  const [editingId, setEditingId] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<AigcWorkflowOutputMapping>();
  const [draggedMappingId, setDraggedMappingId] = useState("");
  const selectedNode = workflow.nodes.find((node) => node.id === draft?.nodeId);
  const selectedFields = selectedNode ? outputFields(selectedNode) : [];

  function beginAdd() {
    setDraft({ id: "", name: "", nodeId: "", field: "", mediaType: "image", description: "" });
    setBrowseNodeId("");
    setEditingId("");
  }

  function beginEdit(mapping: AigcWorkflowOutputMapping) {
    setDraft({ ...mapping });
    setBrowseNodeId(mapping.nodeId);
    setEditingId(mapping.id);
  }

  function selectMappingNode(nodeId: string) {
    const node = workflow.nodes.find((item) => item.id === nodeId);
    const firstField = node ? outputFields(node)[0] : undefined;
    setDraft((current) => current ? {
      ...current,
      name: current.name || firstField?.name || "",
      nodeId,
      field: autoOutputField(node),
    } : current);
  }

  function updateDraft<K extends keyof AigcWorkflowOutputMapping>(key: K, value: AigcWorkflowOutputMapping[K]) {
    setDraft((current) => {
      if (!current) return current;
      const next = { ...current, [key]: value };
      if (key === "mediaType") {
        const mediaType = value as AigcWorkflowOutputMapping["mediaType"];
        const node = workflow.nodes.find((item) => item.id === current.nodeId);
        const firstField = node ? outputFields(node)[0] : undefined;
        next.field = outputMediaTypeRequiresField(mediaType)
          ? (firstField?.name ?? "outputs.*")
          : autoOutputField(node);
      }
      return next;
    });
  }

  function closeEditor() {
    setDraft(undefined);
    setBrowseNodeId("");
    setEditingId("");
  }

  function commit() {
    if (!draft || !draft.name.trim() || !draft.nodeId) return;
    if (outputMediaTypeRequiresField(draft.mediaType) && !draft.field) return;
    const selectedNodeForCommit = workflow.nodes.find((item) => item.id === draft.nodeId);
    const field = outputMediaTypeRequiresField(draft.mediaType)
      ? draft.field
      : autoOutputField(selectedNodeForCommit);
    const normalized = { ...draft, name: draft.name.trim(), field };
    if (editingId) onChange(mappings.map((mapping) => mapping.id === editingId ? { ...normalized, id: editingId } : mapping));
    else onChange([...mappings, { ...normalized, id: crypto.randomUUID() }]);
    closeEditor();
  }

  function moveOutput(targetId: string) {
    if (!draggedMappingId || draggedMappingId === targetId) return;
    onChange(moveArrayItem(mappings, draggedMappingId, targetId));
    setDraggedMappingId("");
  }

  return (
    <section className="configuration-form-card aigc-config-section">
      <div className="configuration-section__heading">
        <div><span>03</span><h2>输出映射</h2></div>
        <Button variant="primary" type="button" className="configuration-primary-action" onClick={beginAdd}><Plus size={15} />新增输出</Button>
      </div>
      <p className="configuration-help">沿工作流关系找到产物节点，选择节点和媒体类型即可；媒体产物会自动识别输出槽位。</p>

      {mappings.length ? (
        <div className="aigc-mapping-list">
          {mappings.map((mapping) => {
            const node = workflow.nodes.find((item) => item.id === mapping.nodeId);
            return (
              <article key={mapping.id} className="aigc-task-row aigc-mapping-card" draggable onDragStart={() => setDraggedMappingId(mapping.id)} onDragOver={(event) => event.preventDefault()} onDrop={() => moveOutput(mapping.id)}>
                <button type="button" className="aigc-drag-handle" aria-label={`拖动调整${mapping.name}顺序`} title="拖动调整顺序"><GripVertical size={16} /></button>
                <div className="aigc-mapping-card__main">
                  <strong>{mapping.name}</strong>
                  <span title={`${nodeLabel(node, mapping.nodeId)} · ${outputFieldLabel(mapping.field, mapping.mediaType)}`}>{nodeLabel(node, mapping.nodeId)} · {outputFieldLabel(mapping.field, mapping.mediaType)}</span>
                  <small>{mapping.mediaType}</small>
                </div>
                <div className="aigc-task-actions">
                  <button type="button" onClick={() => beginEdit(mapping)}><Pencil size={14} />编辑</button>
                  <button type="button" className="is-danger" onClick={() => setDeleteTarget(mapping)}><Trash2 size={14} />删除</button>
                </div>
              </article>
            );
          })}
        </div>
      ) : <p className="configuration-help">还没有输出映射。执行后只能查看原始任务状态，不能自动提取产物。</p>}

      {draft ? (
        <div className="aigc-mapping-editor">
          <div className="configuration-section__heading">
            <strong>{editingId ? "编辑输出" : "新增输出"}</strong>
            <button type="button" className="icon-button" aria-label="关闭输出编辑" onClick={closeEditor}><X size={15} /></button>
          </div>
          <div className="aigc-mapping-workspace">
            <WorkflowNodeNavigator
              workflow={workflow}
              browseNodeId={browseNodeId}
              mappingNodeId={draft.nodeId}
              mappingKind="output"
              onBrowseNodeChange={setBrowseNodeId}
              onSelectMappingNode={selectMappingNode}
            />
            <div className="aigc-mapping-config">
              <MappingTargetSummary node={selectedNode} nodeId={draft.nodeId} field={outputFieldLabel(draft.field, draft.mediaType)} />
              {outputMediaTypeRequiresField(draft.mediaType) ? (
                <div className="aigc-fieldset">
                  <div className="aigc-fieldset__heading"><strong>映射字段</strong><small>文本或 JSON 输出需要选择具体字段</small></div>
                  <div className="aigc-field-picker">
                    {selectedFields.map((field) => (
                      <button type="button" key={field.name} className={draft.field === field.name ? "is-selected" : undefined} onClick={() => updateDraft("field", field.name)}>
                        <strong title={field.name}>{fieldLabel(field)}</strong><small>{field.kind}</small>
                      </button>
                    ))}
                    {!draft.nodeId ? <p className="configuration-help">请先从左侧将一个节点选为映射节点。</p> : null}
                    {draft.nodeId && !selectedFields.length ? <p className="configuration-help">该节点没有可读取的输出字段。</p> : null}
                  </div>
                </div>
              ) : (
                <div className="aigc-fieldset">
                  <div className="aigc-fieldset__heading"><strong>产物槽位</strong><small>自动扫描该节点的输出槽位</small></div>
                  <p className="configuration-help">图片、视频、音频产物会按文件名和媒体类型自动识别，无需手工选择 outputs.images 或 outputs.videos。</p>
                </div>
              )}
              <div className="aigc-fieldset">
                <div className="aigc-fieldset__heading"><strong>输出配置</strong><small>定义产物名称和媒体类型</small></div>
                <div className="aigc-form-grid">
                  <label><span>显示名称</span><input aria-label="输出名称" value={draft.name} onChange={(event) => updateDraft("name", event.target.value)} /></label>
                  <label><span>媒体类型</span><SearchSelect
                    ariaLabel="输出媒体类型"
                    value={draft.mediaType}
                    onChange={(next) => updateDraft("mediaType", next as AigcWorkflowOutputMapping["mediaType"])}
                    options={outputMediaTypeOptions.map((option) => ({ value: option.value, label: option.label }))}
                  /></label>
                  <label className="aigc-span-2"><span>说明</span><input aria-label="输出说明" value={draft.description ?? ""} onChange={(event) => updateDraft("description", event.target.value)} /></label>
                </div>
              </div>
            </div>
          </div>
          <div className="configuration-save-bar">
            <Button type="button" className="configuration-secondary-action" onClick={closeEditor}>取消</Button>
            <Button variant="primary" type="button" className="configuration-primary-action" disabled={!draft.name.trim() || !draft.nodeId || (outputMediaTypeRequiresField(draft.mediaType) && !draft.field)} onClick={commit}><Check size={15} />{editingId ? "保存修改" : "添加输出"}</Button>
          </div>
        </div>
      ) : null}
      {deleteTarget ? <ConfirmDialog title={`删除输出“${deleteTarget.name}”？`} description="删除后工作台将不再从该节点提取对应产物；保存工作流前仍可取消本次编辑。" confirmLabel="删除输出" onCancel={() => setDeleteTarget(undefined)} onConfirm={() => { onChange(mappings.filter((item) => item.id !== deleteTarget.id)); setDeleteTarget(undefined); }} /> : null}
    </section>
  );
}

interface WorkflowNodeNavigatorProps {
  workflow: AigcWorkflowDetail;
  browseNodeId: string;
  mappingNodeId: string;
  mappingKind: "input" | "output";
  activationNodeIds?: string[];
  blockedActivationNodeIds?: Set<string>;
  onBrowseNodeChange: (nodeId: string) => void;
  onSelectMappingNode: (nodeId: string) => void;
  onActivationNodeIdsChange?: (nodeIds: string[]) => void;
}

/** 以当前浏览节点为中心展示直接上下游，并保持映射目标独立。 */
function WorkflowNodeNavigator(props: WorkflowNodeNavigatorProps) {
  const {
    workflow,
    browseNodeId,
    mappingNodeId,
    mappingKind,
    activationNodeIds,
    blockedActivationNodeIds = new Set<string>(),
    onBrowseNodeChange,
    onSelectMappingNode,
    onActivationNodeIdsChange,
  } = props;
  const [query, setQuery] = useState("");
  const browseNode = workflow.nodes.find((node) => node.id === browseNodeId);
  const normalizedQuery = query.trim().toLocaleLowerCase();
  // 大型工作流由列表滚动承载，不能静默截断后续节点。
  const searchResults = workflow.nodes.filter((node) => {
    if (!normalizedQuery) return !browseNodeId && nodeHasFields(node, mappingKind);
    return [node.id, node.type, node.title ?? ""].some((value) => value.toLocaleLowerCase().includes(normalizedQuery));
  });
  const upstreamEdges = browseNodeId ? workflow.edges.filter((edge) => edge.targetNodeId === browseNodeId) : [];
  const downstreamEdges = browseNodeId ? workflow.edges.filter((edge) => edge.sourceNodeId === browseNodeId) : [];
  const activationSet = new Set(activationNodeIds ?? []);
  const boundaryEdges = activationNodeIds
    ? workflow.edges.filter((edge) => activationSet.has(edge.sourceNodeId) && !activationSet.has(edge.targetNodeId))
    : [];

  function toggleActivationNode(nodeId: string, checked: boolean) {
    if (!activationNodeIds || !onActivationNodeIdsChange) return;
    const next = new Set(activationNodeIds);
    if (checked) next.add(nodeId);
    else if (nodeId !== mappingNodeId) next.delete(nodeId);
    onActivationNodeIdsChange([...next]);
  }

  /** 返回初始节点列表，同时保留已经选择的映射目标和条件节点。 */
  function returnToNodeList() {
    setQuery("");
    onBrowseNodeChange("");
  }

  return (
    <div className="aigc-node-navigator">
      <div className="aigc-node-search">
        <Search size={14} aria-hidden="true" />
        <input aria-label="搜索工作流节点" placeholder="搜索名称、类型或 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
        {browseNodeId ? (
          <button type="button" className="aigc-node-list-return" title="返回节点列表" onClick={returnToNodeList}>
            <ArrowLeft size={13} aria-hidden="true" />节点列表
          </button>
        ) : <small>{workflow.nodes.length} 节点</small>}
      </div>

      {(normalizedQuery || !browseNodeId) ? (
        <div className="aigc-node-search-results" aria-label="节点搜索结果">
          <div className="aigc-fieldset__heading">
            <strong>{normalizedQuery ? "搜索结果" : "可映射节点"}</strong>
            <small>{normalizedQuery ? `找到 ${searchResults.length} 个节点` : "先选择一个节点查看它的上下游"}</small>
          </div>
          <div className="aigc-node-result-list">
            {searchResults.map((node) => (
              <NavigatorNodeCard
                key={node.id}
                node={node}
                mappingNodeId={mappingNodeId}
                activationNodeIds={activationNodeIds}
                activationBlocked={blockedActivationNodeIds.has(node.id)}
                onBrowse={() => { onBrowseNodeChange(node.id); setQuery(""); }}
                onToggleActivation={(checked) => toggleActivationNode(node.id, checked)}
              />
            ))}
            {!searchResults.length ? <p className="configuration-help">没有匹配的节点。</p> : null}
          </div>
        </div>
      ) : null}

      {browseNode && !normalizedQuery ? (
        <>
          <div className="aigc-node-flow" aria-label="工作流节点关系">
            <NodeRelationColumn title="上游" edges={upstreamEdges} workflow={workflow} direction="upstream" mappingNodeId={mappingNodeId} activationNodeIds={activationNodeIds} blockedActivationNodeIds={blockedActivationNodeIds} onBrowse={onBrowseNodeChange} onToggleActivation={toggleActivationNode} />
            <section className="aigc-node-current" aria-label="当前浏览节点详情">
              <div className="aigc-node-column__heading"><strong>当前浏览节点</strong><small>点击两侧节点可重新居中</small></div>
              <NavigatorNodeCard
                node={browseNode}
                current
                mappingNodeId={mappingNodeId}
                activationNodeIds={activationNodeIds}
                activationBlocked={blockedActivationNodeIds.has(browseNode.id)}
                onBrowse={() => undefined}
                onToggleActivation={(checked) => toggleActivationNode(browseNode.id, checked)}
              />
              <button type="button" className="configuration-primary-action aigc-select-mapping-node" disabled={!nodeHasFields(browseNode, mappingKind) || mappingNodeId === browseNode.id} onClick={() => onSelectMappingNode(browseNode.id)}>
                <Check size={14} />{mappingNodeId === browseNode.id ? "已是映射节点" : "选为映射节点"}
              </button>
              {!nodeHasFields(browseNode, mappingKind) ? <small className="aigc-node-unavailable">该节点没有可映射的{mappingKind === "input" ? "输入" : "输出"}字段</small> : null}
            </section>
            <NodeRelationColumn title="下游" edges={downstreamEdges} workflow={workflow} direction="downstream" mappingNodeId={mappingNodeId} activationNodeIds={activationNodeIds} blockedActivationNodeIds={blockedActivationNodeIds} onBrowse={onBrowseNodeChange} onToggleActivation={toggleActivationNode} />
          </div>

          {activationNodeIds ? (
            <div className="aigc-activation-boundary">
              <GitBranch size={15} aria-hidden="true" />
              <div>
                <strong>条件节点组：{activationNodeIds.length} 个节点</strong>
                <small>{boundaryEdges.length ? `${boundaryEdges.length} 条连线从节点组输出到公共流程；缺值时会删除对应目标输入。` : "当前节点组没有连接到组外流程。"}</small>
                {boundaryEdges.length ? <span>{boundaryEdges.slice(0, 3).map((edge) => edgeLabel(edge)).join("；")}{boundaryEdges.length > 3 ? ` 等 ${boundaryEdges.length} 条` : ""}</span> : null}
              </div>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

/** 展示当前节点某一方向的直接关系。 */
function NodeRelationColumn(props: {
  title: string;
  edges: ComfyUiEdge[];
  workflow: AigcWorkflowDetail;
  direction: "upstream" | "downstream";
  mappingNodeId: string;
  activationNodeIds?: string[];
  blockedActivationNodeIds: Set<string>;
  onBrowse: (nodeId: string) => void;
  onToggleActivation: (nodeId: string, checked: boolean) => void;
}) {
  const { title, edges, workflow, direction, mappingNodeId, activationNodeIds, blockedActivationNodeIds, onBrowse, onToggleActivation } = props;
  return (
    <section className="aigc-node-column">
      <div className="aigc-node-column__heading"><strong>{title}</strong><small>{edges.length} 条直接连接</small></div>
      <div className="aigc-node-column__list">
        {edges.map((edge) => {
          const nodeId = direction === "upstream" ? edge.sourceNodeId : edge.targetNodeId;
          const node = workflow.nodes.find((item) => item.id === nodeId);
          if (!node) return null;
          return (
            <div key={edge.id} className="aigc-node-relation">
              <NavigatorNodeCard node={node} mappingNodeId={mappingNodeId} activationNodeIds={activationNodeIds} activationBlocked={blockedActivationNodeIds.has(node.id)} onBrowse={() => onBrowse(node.id)} onToggleActivation={(checked) => onToggleActivation(node.id, checked)} />
              <small title={edgeLabel(edge)}>{edge.sourceField} → {edge.targetField}</small>
            </div>
          );
        })}
        {!edges.length ? <p className="aigc-node-empty">无直接{title}节点</p> : null}
      </div>
    </section>
  );
}

/** 紧凑节点卡片，浏览操作与条件组勾选保持独立。 */
function NavigatorNodeCard(props: {
  node: ComfyUiNode;
  current?: boolean;
  mappingNodeId: string;
  activationNodeIds?: string[];
  activationBlocked: boolean;
  onBrowse: () => void;
  onToggleActivation: (checked: boolean) => void;
}) {
  const { node, current = false, mappingNodeId, activationNodeIds, activationBlocked, onBrowse, onToggleActivation } = props;
  const isMappingNode = mappingNodeId === node.id;
  const inActivation = activationNodeIds?.includes(node.id) ?? false;
  return (
    <div className={`aigc-node-card${current ? " is-current" : ""}${isMappingNode ? " is-mapping" : ""}${inActivation ? " is-conditional" : ""}`}>
      <button type="button" aria-label={`浏览节点 ${nodeLabel(node, node.id)}`} onClick={onBrowse} disabled={current}>
        <span className="aigc-node-card__title" title={nodeLabel(node, node.id)}>{nodeLabel(node, node.id)}</span>
        <span className="aigc-node-card__meta" title={`${node.type} · #${node.id}`}>{node.type} · #{node.id}</span>
        {isMappingNode ? <span className="aigc-node-card__badge">映射目标</span> : null}
      </button>
      {activationNodeIds ? (
        <label title={activationBlocked ? "该节点已属于其他条件参数" : undefined}>
          <Checkbox aria-label={`条件节点 ${nodeLabel(node, node.id)}`} checked={inActivation} disabled={isMappingNode || activationBlocked} onChange={(event) => onToggleActivation(event.target.checked)} />
          <span>{activationBlocked ? "已被占用" : "条件节点"}</span>
        </label>
      ) : null}
    </div>
  );
}

/** 在配置侧持续展示真正的映射目标，避免与浏览节点混淆。 */
function MappingTargetSummary({ node, nodeId, field }: { node?: ComfyUiNode; nodeId: string; field: string }) {
  return (
    <div className={`aigc-mapping-target${node ? " is-selected" : ""}`} aria-label="当前映射目标">
      <span>映射目标</span>
      <strong title={node ? nodeLabel(node, nodeId) : undefined}>{node ? nodeLabel(node, nodeId) : "尚未选择"}</strong>
      <small title={field || undefined}>{node ? `${node.type} · #${node.id}${field ? ` · ${field}` : ""}` : "在左侧浏览节点后明确选择"}</small>
    </div>
  );
}

/** 获取可映射为入参的节点字段。 */
function inputFields(node: ComfyUiNode): ComfyUiField[] {
  return node.fields.filter((field) => field.kind === "input" || field.kind === "widget");
}

/** 获取可读取的节点输出字段。 */
function outputFields(node: ComfyUiNode): ComfyUiField[] {
  return node.fields.filter((field) => field.kind === "output");
}

/** 判断文本或 JSON 输出是否需要用户显式选择字段。 */
function outputMediaTypeRequiresField(mediaType: AigcWorkflowOutputMapping["mediaType"]): boolean {
  return mediaType === "text" || mediaType === "json";
}

/** 生成媒体产物可提交的自动输出字段路径。 */
function autoOutputField(node?: ComfyUiNode): string {
  const firstField = node ? outputFields(node)[0] : undefined;
  return firstField?.name ?? "outputs.*";
}

/** 按媒体类型展示输出字段或自动识别状态。 */
function outputFieldLabel(field: string, mediaType: AigcWorkflowOutputMapping["mediaType"]): string {
  return outputMediaTypeRequiresField(mediaType) ? field : "自动识别";
}

function nodeHasFields(node: ComfyUiNode, kind: "input" | "output"): boolean {
  return (kind === "input" ? inputFields(node) : outputFields(node)).length > 0;
}

function nodeLabel(node: ComfyUiNode | undefined, fallback: string): string {
  return node?.title || node?.type || fallback;
}

/** 展示 ComfyUI 字段别名，同时保留字段 name 作为实际映射路径。 */
function fieldLabel(field: ComfyUiField): string {
  return field.label?.trim() || field.name;
}

/** 汇总节点选项同时展示检索所依据的 ID、标题和类型。 */
function referenceBoundaryLabel(node: ComfyUiNode): string {
  const title = node.title?.trim();
  return title && title !== node.type ? `#${node.id} ${title} · ${node.type}` : `#${node.id} ${node.type}`;
}

function edgeLabel(edge: ComfyUiEdge): string {
  return `#${edge.sourceNodeId} ${edge.sourceField} → #${edge.targetNodeId} ${edge.targetField}`;
}

/** 从字段名生成一个可读的默认参数名。 */
function parameterNameFromField(field: ComfyUiField): string {
  if (field.label?.trim()) return field.label.trim();
  const last = field.name.split(".").at(-1) ?? field.name;
  return last || "value";
}

function cloneInputMapping(mapping: AigcWorkflowInputMapping): AigcWorkflowInputMapping {
  return {
    ...mapping,
    ...(mapping.enumOptions ? { enumOptions: [...mapping.enumOptions] } : {}),
    ...(mapping.activation ? { activation: { ...mapping.activation, nodeIds: [...mapping.activation.nodeIds] } } : {}),
  };
}

const inputTypeOptions: Array<{ value: AigcWorkflowInputType; label: string }> = [
  { value: "bool", label: "布尔（bool）" },
  { value: "int", label: "整数（int）" },
  { value: "double", label: "浮点（double）" },
  { value: "string", label: "字符串（string）" },
  { value: "enum", label: "枚举（enum）" },
  { value: "image", label: "图片（image）" },
  { value: "video", label: "视频（video）" },
  { value: "audio", label: "音频（audio）" },
];

type InputListItem =
  | { id: string; kind: "mapping"; mapping: AigcWorkflowInputMapping; mappingIds: string[] }
  | { id: string; kind: "group"; group: AigcWorkflowInputGroup; mappingIds: string[] };

/** 将参考组压缩为一个顶层入参列表项。 */
function inputListItems(mappings: AigcWorkflowInputMapping[], groups: AigcWorkflowInputGroup[]): InputListItem[] {
  const groupByMappingId = new Map(groups.flatMap((group) => group.mappingIds.map((mappingId) => [mappingId, group] as const)));
  const emittedGroups = new Set<string>();
  const items: InputListItem[] = [];
  for (const mapping of mappings) {
    const group = groupByMappingId.get(mapping.id);
    if (!group) items.push({ id: mapping.id, kind: "mapping", mapping, mappingIds: [mapping.id] });
    else if (!emittedGroups.has(group.id)) {
      emittedGroups.add(group.id);
      items.push({ id: group.id, kind: "group", group, mappingIds: [...group.mappingIds] });
    }
  }
  return items;
}

/** 以顶层参数块为单位重排，参考组内部顺序保持不变。 */
export function reorderInputMappings(mappings: AigcWorkflowInputMapping[], groups: AigcWorkflowInputGroup[], sourceId: string, targetId: string): AigcWorkflowInputMapping[] {
  const items = inputListItems(mappings, groups);
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return mappings;
  const reordered = [...items];
  const [source] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, source);
  const mappingById = new Map(mappings.map((mapping) => [mapping.id, mapping]));
  return reordered.flatMap((item) => item.mappingIds.map((id) => mappingById.get(id)).filter((mapping): mapping is AigcWorkflowInputMapping => Boolean(mapping)));
}

/** 将普通映射移动到目标映射位置。 */
function moveArrayItem<T extends { id: string }>(items: T[], sourceId: string, targetId: string): T[] {
  const sourceIndex = items.findIndex((item) => item.id === sourceId);
  const targetIndex = items.findIndex((item) => item.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return items;
  const reordered = [...items];
  const [source] = reordered.splice(sourceIndex, 1);
  reordered.splice(targetIndex, 0, source);
  return reordered;
}

/** 安全生成参考组拓扑预览，避免不合法分支中断编辑器渲染。 */
function referenceGroupPreview(workflow: AigcWorkflowDetail, boundaryNodeId: string, prefix: string) {
  if (!boundaryNodeId || !prefix) return { branches: [], fields: [], error: "" };
  try {
    const branches = traceReferenceInputBranches(workflow, boundaryNodeId, prefix);
    return { branches, fields: commonReferenceInputFields(workflow, branches), error: "" };
  } catch (error) {
    return { branches: [], fields: [], error: error instanceof Error ? error.message : "无法识别参考输入分支" };
  }
}

/** 避免自动创建的映射名称与现有参数重名。 */
function uniqueMappingName(candidate: string, mappings: AigcWorkflowInputMapping[]): string {
  const names = new Set(mappings.map((mapping) => mapping.name));
  if (!names.has(candidate)) return candidate;
  let suffix = 2;
  while (names.has(`${candidate}_${suffix}`)) suffix += 1;
  return `${candidate}_${suffix}`;
}

const outputMediaTypeOptions: Array<{ value: AigcWorkflowOutputMapping["mediaType"]; label: string }> = [
  { value: "image", label: "图片（image）" },
  { value: "video", label: "视频（video）" },
  { value: "audio", label: "音频（audio）" },
  { value: "json", label: "JSON" },
  { value: "text", label: "文本（text）" },
];

/** 根据字段类型渲染不会吞掉数值输入中间态的默认值控件。 */
function DefaultValueField(props: {
  mapping: AigcWorkflowInputMapping;
  metadata?: ComfyUiFieldMetadata;
  value: string;
  error: string;
  onChange: (value: string) => void;
}) {
  const { mapping, metadata, value, error, onChange } = props;
  const options = effectiveEnumOptions(mapping, metadata) ?? [];
  return (
    <label>
      <span>默认值</span>
      {mapping.type === "bool" ? (
        <SearchSelect
          ariaLabel="入参默认值"
          value={value}
          onChange={(next) => onChange(next)}
          options={[
            { value: "", label: "未设置" },
            { value: "true", label: "true" },
            { value: "false", label: "false" },
          ]}
        />
      ) : mapping.type === "enum" ? (
        <SearchSelect
          ariaLabel="入参默认值"
          value={value}
          onChange={(next) => onChange(next)}
          options={[
            { value: "", label: "未设置" },
            ...options.map((option) => ({ value: scalarKey(option), label: String(option) })),
          ]}
        />
      ) : (
        <input type="text" inputMode={mapping.type === "int" || mapping.type === "double" ? "decimal" : undefined} aria-label="入参默认值" aria-invalid={error ? "true" : undefined} placeholder={metadata?.placeholder} value={value} onChange={(event) => onChange(event.target.value)} />
      )}
      {error ? <small className="aigc-field-error" role="alert">{error}</small> : metadataRangeText(metadata) ? <small>{metadataRangeText(metadata)}</small> : null}
    </label>
  );
}

/** 将默认值稳定转换为文本草稿或枚举标量键。 */
function inputDefaultValueDraft(mapping: AigcWorkflowInputMapping): string {
  if (mapping.defaultValue === undefined) return "";
  return defaultValueDraftFromScalar(mapping.defaultValue, mapping.type);
}

function defaultValueDraftFromScalar(value: string | number | boolean, type?: AigcWorkflowInputType): string {
  return type === "enum" ? scalarKey(value) : String(value);
}

/** 提交编辑器时才把数值草稿解析为最终标量。 */
function parseDefaultValueDraft(type: AigcWorkflowInputType, draft: string, enumOptions?: Array<string | number | boolean>): { value?: string | number | boolean; error?: string } {
  if (draft === "") return {};
  if (type === "bool") return draft === "true" ? { value: true } : draft === "false" ? { value: false } : { error: "布尔默认值无效" };
  if (type === "enum") {
    const value = enumOptions?.find((option) => scalarKey(option) === draft);
    return value === undefined ? { error: "请选择有效的枚举默认值" } : { value };
  }
  if (type === "int" || type === "double") {
    const number = Number(draft);
    if (!Number.isFinite(number)) return { error: "请输入完整的有限数值" };
    if (type === "int" && !Number.isInteger(number)) return { error: "整数默认值不能包含小数" };
    return { value: number };
  }
  return { value: draft };
}

/** 在浏览器内即时提示可确定的值域错误，服务端仍会再次校验。 */
function defaultValueConstraintError(value: string | number | boolean | undefined, type: AigcWorkflowInputType, metadata?: ComfyUiFieldMetadata, enumOptions?: Array<string | number | boolean>): string | undefined {
  if (typeof value === "number" && metadata?.min !== undefined && value < metadata.min) return `不能小于 ${metadata.min}`;
  if (typeof value === "number" && metadata?.max !== undefined && value > metadata.max) return `不能大于 ${metadata.max}`;
  const allowed = enumOptions ?? metadata?.enumOptions;
  if (type === "enum" && value !== undefined && allowed && !allowed.some((option) => Object.is(option, value))) return "默认值不在枚举候选中";
  return undefined;
}

/** 节点定义优先约束候选值，定义缺失时才使用映射的手动候选。 */
function effectiveEnumOptions(mapping: AigcWorkflowInputMapping, metadata?: ComfyUiFieldMetadata): Array<string | number | boolean> | undefined {
  return metadata?.enumOptions?.length ? metadata.enumOptions : mapping.enumOptions;
}

/** 读取指定节点字段的权威元数据。 */
function fieldMetadata(workflow: AigcWorkflowDetail, node: ComfyUiNode | undefined, field: string): ComfyUiFieldMetadata | undefined {
  return node
    ? workflow.resolvedFieldMetadata?.[node.id]?.[field] ?? workflow.nodeMetadata?.[node.type]?.fields[field]
    : undefined;
}

/** 从实例级元数据中读取动态推导冲突。 */
function metadataConflict(metadata?: ComfyUiFieldMetadata): string | undefined {
  return metadata && "conflict" in metadata && typeof metadata.conflict === "string" ? metadata.conflict : undefined;
}

/** 为字段卡片生成紧凑的类型与范围摘要。 */
function fieldMetadataSummary(metadata?: ComfyUiFieldMetadata): string | undefined {
  if (!metadata) return undefined;
  return [metadata.comfyType, metadataRangeText(metadata)].filter(Boolean).join(" · ");
}

function metadataRangeText(metadata?: ComfyUiFieldMetadata): string | undefined {
  if (!metadata) return undefined;
  const range = metadata.min !== undefined || metadata.max !== undefined ? `${metadata.min ?? "−∞"}–${metadata.max ?? "+∞"}` : "";
  return [range, metadata.step !== undefined ? `步进 ${metadata.step}` : ""].filter(Boolean).join(" · ") || undefined;
}

function scalarKey(value: string | number | boolean): string {
  return `${typeof value}:${String(value)}`;
}
