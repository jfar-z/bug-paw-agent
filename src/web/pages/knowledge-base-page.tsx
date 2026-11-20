import { Button, IconButton, SearchField, TextField, Textarea } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { useWorkbenchNavigation } from "../layouts/workbench-shell";
import { BookOpen, FileSearch, FileText, Pencil, Plus, Trash2, Upload, Users, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import { api, type KnowledgeBaseDetail, type KnowledgeDocumentChunk, type KnowledgeDocumentSummary, type KnowledgeSearchResult } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { MarkdownContent } from "../components/markdown-content";
import { SecondarySidebarHeader } from "../ui/sidebar-header";
import { ConfirmDialog, Dialog } from "../ui/dialog";
import { Tabs } from "../ui/tabs";

import { KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT } from "../router";
import "../configuration.css";
import "../library-workspace.css";
import "../knowledge-base.css";

export { KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT } from "../router";

/** 以知识库列表为二级导航，管理资料、绑定关系与检索结果。 */
export function KnowledgeBasePage() {
  const { runApiTask } = useApiTask();
  const [bases, setBases] = useState<KnowledgeBaseDetail[]>([]);
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [baseToDelete, setBaseToDelete] = useState<KnowledgeBaseDetail>();
  const navigation = useWorkbenchNavigation();
  const [standaloneNavigationOpen, setStandaloneNavigationOpen] = useState(false);
  const mobileNavigationOpen = navigation ? navigation.drawer === "secondary" : standaloneNavigationOpen;
  const closeNavigation = () => navigation ? navigation.close() : setStandaloneNavigationOpen(false);
  const [error, setError] = useState("");
  const [directoryStatus, setDirectoryStatus] = useState<"loading" | "ready" | "error">("loading");
  const selected = bases.find((base) => base.id === selectedId);

  const reload = async () => {
    setDirectoryStatus("loading");
    setError("");
    const result = await runApiTask(
      () => Promise.all([api.listKnowledgeBases(), api.listAgents()]),
      { operation: "加载知识库" },
    );
    setDirectoryStatus(result.status === "success" ? "ready" : "error");
    if (result.status === "success") {
      const [{ knowledgeBases }, { agents: loadedAgents }] = result.data;
      const normalizedBases = knowledgeBases.map(normalizeKnowledgeBase);
      setBases(normalizedBases);
      setAgents(loadedAgents);
      setSelectedId((current) => normalizedBases.some((base) => base.id === current) ? current : normalizedBases[0]?.id ?? "");
    }
  };

  useEffect(() => { void reload(); }, [runApiTask]);
  useEffect(() => {
    const toggle = () => setStandaloneNavigationOpen((current) => !current);
    window.addEventListener(KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT, toggle);
    return () => window.removeEventListener(KNOWLEDGE_BASE_NAVIGATION_TOGGLE_EVENT, toggle);
  }, []);

  const removeKnowledgeBase = async (base: KnowledgeBaseDetail) => {
    const result = await runApiTask(
      () => api.deleteKnowledgeBase(base.id),
      { operation: "删除知识库", expected: knowledgeExpected(setError) },
    );
    if (result.status !== "success") return false;
    setBases((current) => {
      const removedIndex = current.findIndex((item) => item.id === base.id);
      const remaining = current.filter((item) => item.id !== base.id);
      const next = remaining[Math.min(removedIndex, remaining.length - 1)];
      setSelectedId((currentSelectedId) => currentSelectedId === base.id ? next?.id ?? "" : currentSelectedId);
      return remaining;
    });
    closeNavigation();
    return true;
  };

  const finishCreation = (base: KnowledgeBaseDetail) => {
    const normalized = normalizeKnowledgeBase(base);
    setBases((current) => [...current, normalized]);
    setSelectedId(normalized.id);
    closeNavigation();
    setCreateOpen(false);
    if (bases.length && !mobileNavigationOpen) return;
    // 首次创建会替换空态入口，移动端关闭抽屉后回到顶部导航。
    requestAnimationFrame(() => {
      const target = window.matchMedia("(max-width: 760px)").matches
        ? ".workbench-secondary-menu"
        : ".knowledge-base-navigation__create";
      document.querySelector<HTMLButtonElement>(target)?.focus({ preventScroll: true });
    });
  };

  if (!selected && bases.length === 0) {
    return (
      <main className="knowledge-base-page knowledge-base-page--empty">
        <section className="knowledge-base-empty-state" aria-label="知识库为空">
          <img
            className="knowledge-base-empty-state__image"
            src="/brand/bugpaw/bugpaw-sleeping.png"
            alt="BUG 守着空知识库"
          />
          <span>KNOWLEDGE BASE</span>
          <h1>知识库</h1>
          {directoryStatus === "loading" ? <p role="status">正在读取知识库列表…</p>
            : directoryStatus === "error" ? <>
                <p role="alert">知识库列表未能加载，详情见错误通知。</p>
                <Button onClick={() => void reload()}>重新读取列表</Button>
              </>
            : <>
                <p>创建一个独立知识库，再将它绑定给一个或多个 Agent。</p>
                <Button variant="primary" type="button" className="configuration-primary-action" onClick={() => setCreateOpen(true)}>创建知识库</Button>
              </>}

          {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
        </section>
        {createOpen ? <KnowledgeBaseDialog agents={agents} onCancel={() => setCreateOpen(false)} onCreated={finishCreation} /> : null}
      </main>
    );
  }

  return (
    <main className="knowledge-base-page">
      <aside className={mobileNavigationOpen ? "knowledge-base-navigation is-mobile-open" : "knowledge-base-navigation"}>
        <SecondarySidebarHeader eyebrow="KNOWLEDGE BASES" title="知识库"
          actions={mobileNavigationOpen ? <IconButton label="关闭知识库列表" onClick={closeNavigation}><X size={18} /></IconButton> : undefined} />
        <nav aria-label="知识库列表">
          {bases.map((base) => <button key={base.id} type="button" className={base.id === selectedId ? "is-active" : undefined} aria-current={base.id === selectedId ? "page" : undefined} aria-label={`选择知识库 ${base.name}`} onClick={() => { setSelectedId(base.id); closeNavigation(); }}><BookOpen size={16} aria-hidden="true" /><span><strong>{base.name}</strong><small>{base.documents.length} 份资料</small></span></button>)}
        </nav>
        <Button variant="ghost" className="knowledge-base-navigation__create" icon={<Plus aria-hidden />} onClick={() => setCreateOpen(true)}>创建知识库</Button>
      </aside>
      {mobileNavigationOpen ? <button type="button" className="knowledge-base-navigation__scrim" aria-label="关闭知识库抽屉" tabIndex={-1} onClick={() => closeNavigation()} /> : null}
      {selected ? <KnowledgeBaseWorkspace key={selected.id} base={selected} agents={agents} onChanged={(base) => setBases((current) => current.map((item) => item.id === base.id ? base : item))} onDeleteRequested={setBaseToDelete} onError={setError} /> : null}
      {error ? <p className="configuration-inline-error knowledge-base-page__error" role="alert">{error}</p> : null}
      {createOpen ? <KnowledgeBaseDialog agents={agents} onCancel={() => setCreateOpen(false)} onCreated={finishCreation} /> : null}
      {baseToDelete ? <DeleteKnowledgeBaseDialog base={baseToDelete} onCancel={() => setBaseToDelete(undefined)} onConfirm={async () => { if (await removeKnowledgeBase(baseToDelete)) setBaseToDelete(undefined); }} /> : null}
    </main>
  );
}

/** 兼容旧版创建响应，确保页面依赖的集合字段始终存在。 */
function normalizeKnowledgeBase(base: KnowledgeBaseDetail): KnowledgeBaseDetail {
  return {
    ...base,
    agentIds: Array.isArray(base.agentIds) ? base.agentIds : [],
    documents: Array.isArray(base.documents) ? base.documents : [],
  };
}

/** 展示一个知识库的资料、绑定和检索工作区。 */
function KnowledgeBaseWorkspace({ base, agents, onChanged, onDeleteRequested, onError }: { base: KnowledgeBaseDetail; agents: AgentProfileDocument[]; onChanged: (base: KnowledgeBaseDetail) => void; onDeleteRequested: (base: KnowledgeBaseDetail) => void; onError: (message: string) => void }) {
  const { runApiTask } = useApiTask();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<KnowledgeSearchResult[]>([]);
  const [document, setDocument] = useState<KnowledgeDocumentSummary>();
  const [bindingOpen, setBindingOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [documentToDelete, setDocumentToDelete] = useState<KnowledgeDocumentSummary>();
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const runSearch = async () => {
    if (busy || !query.trim()) return;
    setBusy(true);
    try {
      const result = await runApiTask(() => api.searchKnowledgeBase(base.id, query.trim()), { operation: "检索知识库", expected: knowledgeExpected(onError) });
      if (result.status === "success") setResults(result.data.results);
    }
    finally { setBusy(false); }
  };
  const upload = async (files: FileList | null) => {
    if (!files?.length) return;
    setBusy(true);
    try {
      const result = await runApiTask(async () => {
        await api.uploadKnowledgeDocuments(base.id, [...files]);
        return api.getKnowledgeBase(base.id);
      }, { operation: "上传知识库资料", expected: knowledgeExpected(onError) });
      if (result.status === "success") onChanged(result.data);
    }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = ""; }
  };
  const openDocument = async (documentId: string) => {
    const result = await runApiTask(() => api.getKnowledgeDocument(base.id, documentId), { operation: "读取知识库资料", expected: knowledgeExpected(onError) });
    if (result.status === "success") setDocument(result.data);
  };
  const removeDocument = async () => {
    if (!documentToDelete) return;
    setBusy(true);
    try {
      const result = await runApiTask(async () => {
        await api.deleteKnowledgeDocument(base.id, documentToDelete.id);
        return api.getKnowledgeBase(base.id);
      }, { operation: "删除知识库资料", expected: knowledgeExpected(onError) });
      if (result.status === "success") { onChanged(result.data); setDocumentToDelete(undefined); }
    } finally {
      setBusy(false);
    }
  };

  return <section className="knowledge-base-workspace">
    <header className="knowledge-base-workspace__heading">
      <div><span>KNOWLEDGE BASE</span><h1>{base.name}</h1><p>{base.description || "独立管理的可检索资料集合。"}</p></div>
      <input ref={inputRef} id="knowledge-base-upload" className="knowledge-base-upload-input" type="file" accept=".txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document" multiple onChange={(event) => void upload(event.target.files)} />
      <div className="knowledge-base-workspace__actions">
        <Button type="button" className="configuration-secondary-action" disabled={busy} onClick={() => setEditOpen(true)}><Pencil size={15} aria-hidden="true" />编辑知识库</Button>
        <Button variant="primary" type="button" className="configuration-primary-action" disabled={busy} onClick={() => inputRef.current?.click()}><Upload size={16} aria-hidden="true" />上传资料</Button>
      </div>
    </header>
    <section className="knowledge-base-overview" aria-label="知识库概览">
      <div><span>资料条目</span><strong>{base.documents.length}</strong><small>TXT、Markdown、PDF、DOCX</small></div>
      <div><span>已绑定 Agent</span><strong>{base.agentIds.length}</strong><small>可双向绑定</small></div>
      <div><span>检索模式</span><strong>语义优先</strong><small>未启用或未命中时全文回退</small></div>
    </section>
    <section className="knowledge-base-workspace__content">
      <section className="knowledge-base-documents" aria-label="资料列表">
        <header><div><span>SOURCES</span><h2>资料</h2></div><small>扫描 PDF 将标记为需要 OCR</small></header>
        {base.documents.length === 0 ? <div className="knowledge-base-documents__empty"><FileText size={20} aria-hidden="true" /><p>尚无资料。上传 TXT、Markdown、PDF 或 DOCX 后即可检索。</p></div> : <ul>{base.documents.map((item) => <li key={item.id}><button type="button" aria-label={`查看资料 ${item.name}`} onClick={() => void openDocument(item.id)}><FileText size={16} aria-hidden="true" /><span><strong>{item.name}</strong><small>{statusLabel(item)}</small></span></button><div className="knowledge-base-document-actions"><span className={`knowledge-base-status is-${item.status}`}>{statusLabel(item)}</span><IconButton danger label={`删除资料 ${item.name}`} disabled={busy} onClick={() => setDocumentToDelete(item)}><Trash2 /></IconButton></div></li>)}</ul>}
      </section>
      <aside className="knowledge-base-side-panel">
        <section><header><Users size={15} aria-hidden="true" /><span>AGENT BINDINGS</span></header><p>{base.agentIds.length ? base.agentIds.map((id) => agents.find((agent) => agent.profile.id === id)?.profile.name ?? id).join("、") : "尚未绑定 Agent"}</p><Button onClick={() => setBindingOpen(true)}>管理绑定</Button></section>
        <section><header><FileSearch size={15} aria-hidden="true" /><span>INDEX</span></header><p>使用本地 LanceDB 全文与向量索引。语义检索可在配置中心启用或关闭。</p></section>
      </aside>
    </section>
    <section className="knowledge-base-search-panel" aria-label="检索知识库">
      <header><div><span>SEARCH</span><h2>检索资料</h2></div></header>
      <form className="knowledge-base-search-panel__form" onSubmit={(event) => { event.preventDefault(); void runSearch(); }}>
        <SearchField label="检索知识库" value={query} placeholder="输入关键词，例如：请假流程" onChange={setQuery} />
        <Button type="submit" loading={busy} disabled={!query.trim()}>检索</Button>
      </form>
      {results.length ? <ol className="knowledge-base-search-results">{results.map((result) => <li key={result.chunkId}><button type="button" onClick={() => void openDocument(result.documentId)}><strong>{base.documents.find((item) => item.id === result.documentId)?.name ?? "资料"}</strong><p>{result.text}</p></button></li>)}</ol> : null}
    </section>
    {bindingOpen ? <BindingDialog base={base} agents={agents} onCancel={() => setBindingOpen(false)} onSaved={(updated) => { onChanged(updated); setBindingOpen(false); }} /> : null}
    {editOpen ? <EditKnowledgeBaseDialog base={base} onCancel={() => setEditOpen(false)} onDeleteRequested={() => onDeleteRequested(base)} onSaved={(updated) => { onChanged(updated); setEditOpen(false); }} /> : null}
    {document ? <DocumentDialog document={document} onClose={() => setDocument(undefined)} /> : null}
    {documentToDelete ? <ConfirmDialog title="删除资料" description={`确定删除“${documentToDelete.name}”吗？这会同时删除其检索索引。`} confirmLabel="删除资料" busy={busy} onCancel={() => setDocumentToDelete(undefined)} onConfirm={() => void removeDocument()} /> : null}
  </section>;
}

/** 创建知识库并选择初始绑定 Agent 的应用内对话框。 */
function KnowledgeBaseDialog({ agents, onCancel, onCreated }: { agents: AgentProfileDocument[]; onCancel: () => void; onCreated: (base: KnowledgeBaseDetail) => void }) {
  const { runApiTask } = useApiTask();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [agentIds, setAgentIds] = useState<string[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const formId = useId();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !name.trim()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await runApiTask(() => api.createKnowledgeBase({ name, description, agentIds }), { operation: "创建知识库", expected: knowledgeExpected(setError) });
      if (result.status === "success") onCreated(result.data);
    }
    finally { pending.current = false; setBusy(false); }
  };
  return <Dialog title="创建知识库" closeLabel="关闭创建知识库" onClose={onCancel} busy={busy} className="knowledge-base-dialog"
    footer={<>
      <Button disabled={busy} onClick={onCancel}>取消</Button>
      <Button form={formId} type="submit" variant="primary" loading={busy} disabled={!name.trim()}>创建知识库</Button>
    </>}>
    <form id={formId} className="knowledge-base-dialog__form" onSubmit={submit}>
      <label className="bp-field">名称<TextField aria-label="知识库名称" value={name} maxLength={80} data-initial-focus onChange={(event) => setName(event.target.value)} /></label>
      <label className="bp-field">说明<Textarea aria-label="知识库说明" value={description} maxLength={300} onChange={(event) => setDescription(event.target.value)} /></label>
      <fieldset>
        <legend>绑定 Agent</legend>
        {agents.map((agent) => <label key={agent.profile.id} className="knowledge-base-agent-choice"><Checkbox aria-label={`绑定 Agent ${agent.profile.name}`} checked={agentIds.includes(agent.profile.id)} onChange={() => setAgentIds((current) => current.includes(agent.profile.id) ? current.filter((id) => id !== agent.profile.id) : [...current, agent.profile.id])} />{agent.profile.name}</label>)}
      </fieldset>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
    </form>
  </Dialog>;
}

/** 修改一个知识库的 Agent 多对多绑定关系。 */
function BindingDialog({ base, agents, onCancel, onSaved }: { base: KnowledgeBaseDetail; agents: AgentProfileDocument[]; onCancel: () => void; onSaved: (base: KnowledgeBaseDetail) => void }) {
  const { runApiTask } = useApiTask();
  const [agentIds, setAgentIds] = useState(base.agentIds);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const formId = useId();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await runApiTask(() => api.updateKnowledgeBase(base.id, { agentIds }), { operation: "保存知识库绑定", expected: knowledgeExpected(setError) });
      if (result.status === "success") onSaved(result.data);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <Dialog title="管理 Agent 绑定" closeLabel="关闭 Agent 绑定" onClose={onCancel} busy={busy} className="knowledge-base-dialog"
    footer={<>
      <Button disabled={busy} onClick={onCancel}>取消</Button>
      <Button form={formId} type="submit" variant="primary" loading={busy}>保存绑定</Button>
    </>}>
    <p>已绑定的 Agent 可使用知识库检索和单文件详情工具。</p>
    <form id={formId} onSubmit={submit}>
      <fieldset aria-label="绑定 Agent">
        {agents.map((agent) => <label key={agent.profile.id} className="knowledge-base-agent-choice"><Checkbox aria-label={`绑定 Agent ${agent.profile.name}`} checked={agentIds.includes(agent.profile.id)} onChange={() => setAgentIds((current) => current.includes(agent.profile.id) ? current.filter((id) => id !== agent.profile.id) : [...current, agent.profile.id])} />{agent.profile.name}</label>)}
      </fieldset>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
    </form>
  </Dialog>;
}

/** 编辑知识库名称与说明，不改变其 Agent 绑定关系。 */
function EditKnowledgeBaseDialog({ base, onCancel, onDeleteRequested, onSaved }: { base: KnowledgeBaseDetail; onCancel: () => void; onDeleteRequested: () => void; onSaved: (base: KnowledgeBaseDetail) => void }) {
  const { runApiTask } = useApiTask();
  const [name, setName] = useState(base.name);
  const [description, setDescription] = useState(base.description);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const formId = useId();
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current || !name.trim()) return;
    pending.current = true;
    setBusy(true);
    setError("");
    try {
      const result = await runApiTask(() => api.updateKnowledgeBase(base.id, { name, description }), { operation: "编辑知识库", expected: knowledgeExpected(setError) });
      if (result.status === "success") onSaved(result.data);
    } finally {
      pending.current = false;
      setBusy(false);
    }
  };
  return <Dialog title="编辑知识库" closeLabel="关闭编辑知识库" onClose={onCancel} busy={busy} className="knowledge-base-dialog"
    footer={<>
      <Button disabled={busy} onClick={onCancel}>取消</Button>
      <Button form={formId} type="submit" variant="primary" loading={busy} disabled={!name.trim()}>保存</Button>
    </>}>
    <form id={formId} className="knowledge-base-dialog__form" onSubmit={submit}>
      <label className="bp-field">名称<TextField aria-label="知识库名称" value={name} maxLength={80} data-initial-focus onChange={(event) => setName(event.target.value)} /></label>
      <label className="bp-field">说明<Textarea aria-label="知识库说明" value={description} maxLength={300} onChange={(event) => setDescription(event.target.value)} /></label>
      {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
    </form>
    <section className="knowledge-base-danger-zone" aria-label="危险操作">
      <div><strong>删除知识库</strong><p>永久删除其中的资料、检索索引和 Agent 绑定关系。</p></div>
      <Button variant="danger" disabled={busy} onClick={onDeleteRequested} icon={<Trash2 size={15} aria-hidden="true" />}>删除知识库</Button>
    </section>
  </Dialog>;
}

/** 以知识库名称作为强确认条件，防止误删整库资料与索引。 */
function DeleteKnowledgeBaseDialog({ base, onCancel, onConfirm }: { base: KnowledgeBaseDetail; onCancel: () => void; onConfirm: () => Promise<void> }) {
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const canDelete = confirmation === base.name && !busy;

  const remove = async () => {
    if (!canDelete) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "知识库删除确认流程捕获到非 Error 异常");
    } finally {
      setBusy(false);
    }
  };

  return <Dialog title="永久删除知识库" busy={busy} className="knowledge-base-dialog"
    footer={<>
      <Button disabled={busy} onClick={onCancel}>取消</Button>
      <Button variant="danger" loading={busy} disabled={!canDelete} onClick={() => void remove()}>永久删除知识库</Button>
    </>}>
    <p>“{base.name}”包含 {base.documents.length} 份资料，已绑定 {base.agentIds.length} 个 Agent。资料、检索索引和绑定关系都将永久删除，且无法恢复。</p>
    <label className="bp-field">输入“{base.name}”以确认<TextField aria-label="输入知识库名称以确认" value={confirmation} disabled={busy} data-initial-focus onChange={(event) => setConfirmation(event.target.value)} /></label>
    {error ? <p className="configuration-inline-error" role="alert">{error}</p> : null}
  </Dialog>;
}

/** 显示单份资料的状态、原因和可读文本。 */
function DocumentDialog({ document, onClose }: { document: KnowledgeDocumentSummary; onClose: () => void }) {
  const { runApiTask } = useApiTask();
  const [displayMode, setDisplayMode] = useState<"markdown" | "source" | "chunks">("markdown");
  const [chunks, setChunks] = useState<KnowledgeDocumentChunk[]>();
  const [chunksLoading, setChunksLoading] = useState(false);
  const [chunksError, setChunksError] = useState("");
  const showChunks = async () => {
    setDisplayMode("chunks");
    if (chunks || chunksLoading) return;
    setChunksLoading(true);
    setChunksError("");
    try {
      const result = await runApiTask(
        () => api.listKnowledgeDocumentChunks(document.knowledgeBaseId, document.id),
        { operation: "读取知识库资料分片", expected: knowledgeExpected(setChunksError) },
      );
      if (result.status === "success") setChunks(result.data.chunks);
    } finally {
      setChunksLoading(false);
    }
  };
  return <Dialog title={document.name} closeLabel="关闭资料详情" onClose={onClose} className="knowledge-base-document-dialog">
    <p>状态：{statusLabel(document)}</p>
    {document.failureReason ? <p className="configuration-inline-error">{document.failureReason}</p> : null}
    {document.textTruncated ? <p className="knowledge-base-document-dialog__notice">正文过长，当前仅展示前 12,000 个字符。</p> : null}
    {document.text ? <>
      <Tabs label="资料查看方式" panelId="knowledge-document-preview" value={displayMode}
        items={[{ id: "markdown", label: "Markdown 预览" }, { id: "source", label: "原始文本" }, { id: "chunks", label: "分片内容" }]}
        onChange={(mode) => mode === "chunks" ? void showChunks() : setDisplayMode(mode)} />
      <a className="knowledge-base-document-dialog__source" href={api.knowledgeDocumentSourceUrl(document.knowledgeBaseId, document.id)} target="_blank" rel="noreferrer">打开原文件</a>
      <div id="knowledge-document-preview" role="tabpanel" aria-labelledby={`knowledge-document-preview-${displayMode}`} tabIndex={0}>
        {displayMode === "markdown" ? <MarkdownContent text={document.text} /> : displayMode === "source" ? <pre>{document.text}</pre> : <DocumentChunks chunks={chunks} loading={chunksLoading} error={chunksError} />}
      </div>
    </> : <p>该资料暂无可展示的可提取正文。</p>}
  </Dialog>;
}

/** 将知识库校验、容量和资料格式错误保留在对应操作附近。 */
function knowledgeExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_KNOWLEDGE_BASE: show,
    INVALID_KNOWLEDGE_QUERY: show,
    INVALID_KNOWLEDGE_REQUEST: show,
    KNOWLEDGE_BASE_NOT_FOUND: show,
    KNOWLEDGE_DOCUMENT_NOT_FOUND: show,
    KNOWLEDGE_FILE_TOO_LARGE: show,
    UNSUPPORTED_KNOWLEDGE_FILE: show,
    KNOWLEDGE_UPLOAD_LIMIT: show,
    TEXT_PREVIEW_UNAVAILABLE: show,
  };
}

/** 展示服务端实际用于检索的资料分片。 */
function DocumentChunks({ chunks, loading, error }: { chunks?: KnowledgeDocumentChunk[]; loading: boolean; error: string }) {
  if (loading) return <p>正在读取分片内容…</p>;
  if (error) return <p className="configuration-inline-error" role="alert">{error}</p>;
  if (!chunks?.length) return <p>该资料尚无可展示的索引分片。</p>;
  return <ol className="knowledge-base-document-dialog__chunks">{chunks.map((chunk) => <li key={chunk.chunkId}><header><strong>切片 {chunk.index + 1}</strong>{chunk.page ? <small>第 {chunk.page} 页</small> : null}</header><pre>{chunk.text}</pre></li>)}</ol>;
}

/** 将资料状态转换为用户可读文案。 */
function statusLabel(document: KnowledgeDocumentSummary): string {
  if (document.status === "indexed") return "已建立索引";
  if (document.status === "needs_ocr") return "需要 OCR";
  return "解析失败";
}
