import { ChevronLeft, Database, File, Folder, Plus, Terminal, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ClipboardEvent, type ComponentProps, type DragEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { AgentReference, FileReference } from "../../shared/agent-reference-contracts";
import type { ComposerCatalog } from "../../shared/contracts";
import { useApiTask } from "../api-task-provider";
import { Menu } from "../ui/menu";
import { AgentReferenceChips } from "./agent-reference-chips";

interface ReferenceComposerProps {
  value: string;
  references: AgentReference[];
  disabled: boolean;
  loadCatalog(): Promise<ComposerCatalog>;
  onChange(value: string): void;
  onReferencesChange(references: AgentReference[]): void;
  onSubmit?: () => void;
  onCatalogError?: (message: string) => void;
  /** 接收由剪贴板或拖放输入的本地图片文件。 */
  onFilesInput?: (files: File[]) => void;
  editingContext?: ReactNode;
  attachmentControl?: ReactNode;
  attachmentContent?: ReactNode;
  railControls?: ReactNode;
  bottomControls?: ReactNode;
}

type Candidate =
  | { type: "skill"; name: string; description: string; reference: AgentReference }
  | { type: "knowledge"; name: string; description: string; reference: AgentReference }
  | { type: "file"; name: string; description: string; reference: FileReference }
  | { type: "command"; name: string; description: string };

/** 判断当前回车是否应提交消息，输入法组合和带修饰键的回车保留原生换行。 */
function shouldSubmitComposerOnEnter(event: ReactKeyboardEvent<HTMLTextAreaElement>): boolean {
  if (event.key !== "Enter") return false;
  if (event.nativeEvent.isComposing || event.keyCode === 229) return false;
  if (event.shiftKey || event.ctrlKey || event.metaKey) return false;
  return true;
}

/**
 * 支持 @ 资源引用、/ 安全命令补全与加号快捷选择的对话输入组件。
 */
export function ReferenceComposer({ value, references, disabled, loadCatalog, onChange, onReferencesChange, onSubmit, onCatalogError, onFilesInput, editingContext, attachmentControl, attachmentContent, railControls, bottomControls }: ReferenceComposerProps) {
  const { runApiTask } = useApiTask();
  const [text, setText] = useState(value);
  const [catalog, setCatalog] = useState<ComposerCatalog>();
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const [menuDirectory, setMenuDirectory] = useState("");
  const [draggingInput, setDraggingInput] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const dragDepthRef = useRef(0);
  const candidateMenuRef = useRef<HTMLDivElement>(null);
  const activeTriggerRef = useRef<string | undefined>(undefined);

  useEffect(() => setText(value), [value]);

  const mode = useMemo(() => detectMode(text), [text]);
  const candidates = useMemo(() => catalog ? buildCandidates(catalog, mode, references) : [], [catalog, mode, references]);

  const loadReferenceCatalog = async () => {
    const result = await runApiTask(loadCatalog, {
      operation: "加载引用目录",
      expected: {
        INVALID_REFERENCE: (error) => onCatalogError?.(error.message),
        FILE_NOT_FOUND: (error) => onCatalogError?.(error.message),
        AGENT_NOT_FOUND: (error) => onCatalogError?.(error.message),
      },
    });
    if (result.status === "success") setCatalog(result.data);
  };

  useEffect(() => {
    setActiveIndex((index) => Math.min(index, Math.max(candidates.length - 1, 0)));
  }, [candidates.length]);

  useEffect(() => {
    const activeCandidate = candidateMenuRef.current?.querySelector<HTMLElement>("button[aria-selected='true']");
    if (typeof activeCandidate?.scrollIntoView === "function") {
      activeCandidate.scrollIntoView({ block: "nearest" });
    }
  }, [activeIndex, candidates.length]);

  const updateText = (next: string) => {
    setText(next);
    onChange(next);
    const nextMode = detectMode(next);
    if (!nextMode) {
      activeTriggerRef.current = undefined;
      return;
    }
    const key = `${nextMode.type}:${nextMode.start}`;
    if (activeTriggerRef.current !== key) {
      activeTriggerRef.current = key;
      void loadReferenceCatalog();
    }
  };

  /** 在受控输入框的当前选区插入来自剪贴板或拖放的文本。 */
  const insertAtSelection = (inserted: string) => {
    if (!inserted) return;
    const textarea = textareaRef.current;
    const start = textarea?.selectionStart ?? text.length;
    const end = textarea?.selectionEnd ?? start;
    updateText(`${text.slice(0, start)}${inserted}${text.slice(end)}`);
    window.requestAnimationFrame(() => {
      textarea?.focus();
      textarea?.setSelectionRange(start + inserted.length, start + inserted.length);
    });
  };

  const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return;
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    if (images.length === 0) return;
    event.preventDefault();
    onFilesInput?.(images);
    insertAtSelection(withoutImagePlaceholders(event.clipboardData.getData("text/plain")));
  };

  const handleDrop = (event: DragEvent<HTMLElement>) => {
    dragDepthRef.current = 0;
    setDraggingInput(false);
    if (disabled) return;
    const droppedFiles = Array.from(event.dataTransfer.files);
    if (droppedFiles.length > 0) {
      event.preventDefault();
      const images = droppedFiles.filter((file) => file.type.startsWith("image/"));
      if (images.length > 0) onFilesInput?.(images);
      return;
    }
    const droppedText = event.dataTransfer.getData("text/plain");
    if (!droppedText) return;
    event.preventDefault();
    insertAtSelection(droppedText);
  };

  const addReference = (reference: AgentReference) => {
    const key = referenceKey(reference);
    if (!references.some((item) => referenceKey(item) === key)) {
      onReferencesChange([...references, reference]);
    }
    if (mode?.type === "reference") {
      updateText(`${text.slice(0, mode.start)}${text.slice(mode.end)}`);
    }
  };

  const selectCandidate = (candidate: Candidate | undefined) => {
    if (!candidate) return;
    if (candidate.type !== "command") {
      addReference(candidate.reference);
      return;
    }
    updateText(`/${candidate.name}`);
  };

  const openReferenceMenu = () => {
    setMenuDirectory("");
    if (!catalog && !catalogLoading) {
      setCatalogLoading(true);
      void loadReferenceCatalog().finally(() => setCatalogLoading(false));
    }
  };

  // 文件夹操作替换当前菜单内容，同一个菜单继续管理焦点。
  const menuItems: ComponentProps<typeof Menu>["items"] = [
    ...(menuDirectory ? [{
      key: "parent", label: "返回上级", icon: <ChevronLeft />,
      keepOpen: true, onSelect: () => setMenuDirectory(parentDirectory(menuDirectory)),
    }] : [
      ...(catalog?.skills.map((skill, index) => ({
        key: `skill:${skill.name}`, label: skill.name, icon: <WandSparkles />,
        groupLabel: index === 0 ? "技能" : undefined,
        onSelect: () => addReference({ type: "skill", name: skill.name }),
      })) ?? []),
      ...(catalog?.knowledgeBases.map((base, index) => ({
        key: `knowledge:${base.id}`, label: base.name, icon: <Database />,
        groupLabel: index === 0 ? "知识库" : undefined,
        onSelect: () => addReference({ type: "knowledge", id: base.id, name: base.name }),
      })) ?? []),
    ]),
    ...(catalog?.workspaceEntries.filter((entry) => parentDirectory(entry.path) === menuDirectory).map((entry, index) => ({
      key: `workspace:${entry.path}`, label: entry.name,
      icon: entry.kind === "directory" ? <Folder /> : <File />,
      groupLabel: index === 0 ? "文件" : undefined,
      keepOpen: entry.kind === "directory",
      onSelect: () => {
        if (entry.kind === "directory") setMenuDirectory(entry.path);
        else addReference({ type: "file", path: entry.path, kind: "file", name: entry.name });
      },
    })) ?? []),
  ];
  return (
    <div
      className={`reference-composer${draggingInput ? " is-dragging-input" : ""}`}
      style={draggingInput ? { outline: "2px dashed var(--accent)", background: "var(--accent-soft)" } : undefined}
      onDragEnter={(event) => {
        if (disabled || !supportsDrop(event.dataTransfer.types)) return;
        event.preventDefault();
        dragDepthRef.current += 1;
        setDraggingInput(true);
      }}
      onDragOver={(event) => {
        if (!disabled && supportsDrop(event.dataTransfer.types)) event.preventDefault();
      }}
      onDrop={handleDrop}
      onDragLeave={() => {
        dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
        if (dragDepthRef.current === 0) setDraggingInput(false);
      }}
    >
      {editingContext}
      <AgentReferenceChips references={references} removable onRemove={(reference) => onReferencesChange(references.filter((item) => referenceKey(item) !== referenceKey(reference)))} />
      <div className="reference-composer__input-row">
        <textarea
          ref={textareaRef}
          style={{ touchAction: "pan-y" }}
          rows={1}
          enterKeyHint="enter"
          placeholder="给 Agent 发消息…（输入 @ 引用资源）"
          aria-label="消息内容"
          disabled={disabled}
          value={text}
          onChange={(event) => updateText(event.target.value)}
          onPaste={handlePaste}
          onKeyDown={(event) => {
            if (mode && candidates.length > 0) {
              if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                event.preventDefault();
                setActiveIndex((current) => (current + (event.key === "ArrowDown" ? 1 : -1) + candidates.length) % candidates.length);
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                selectCandidate(candidates[activeIndex]);
                return;
              }
            }
            if (shouldSubmitComposerOnEnter(event)) {
              event.preventDefault();
              onSubmit?.();
            }
          }}
        />
        {mode && candidates.length > 0 ? <div className="reference-composer__candidate-menu" ref={candidateMenuRef} role="listbox" aria-label={mode.type === "reference" ? "引用候选" : "命令候选"}>
          {candidates.map((candidate, index) => <button key={`${candidate.type}:${candidate.name}`} type="button" role="option" aria-label={`${candidateLabel(candidate)} ${candidate.name}`} aria-selected={index === activeIndex} className={index === activeIndex ? "is-active" : ""} onMouseDown={(event) => event.preventDefault()} onClick={() => selectCandidate(candidate)}>
            <CandidateIcon candidate={candidate} />
            <span><b>{candidate.name}</b><small>{candidate.description}</small></span>
          </button>)}
        </div> : null}
      </div>
      {attachmentContent}
      <div className="reference-composer__footer">
        <div className="reference-composer__control-rail">
          <Menu label="添加引用" icon={<Plus />} className="reference-composer__picker"
            triggerVariant="ghost" disabled={disabled} items={menuItems} onOpen={openReferenceMenu}
            focusKey={menuDirectory}
            emptyMessage={catalogLoading ? "正在加载引用目录…" : catalog ? "暂无可引用内容" : undefined} />
          {attachmentControl}
          {railControls}
        </div>
        {bottomControls}
      </div>
    </div>
  );
}

function CandidateIcon({ candidate }: { candidate: Candidate }) {
  if (candidate.type === "skill") return <WandSparkles size={15} />;
  if (candidate.type === "knowledge") return <Database size={15} />;
  if (candidate.type === "command") return <Terminal size={15} />;
  return candidate.reference.kind === "directory" ? <Folder size={15} /> : <File size={15} />;
}

function detectMode(text: string): { type: "reference" | "command"; query: string; start: number; end: number } | undefined {
  const reference = /(^|\s)@([^\s@]*)$/.exec(text);
  if (reference && reference.index !== undefined) {
    const start = reference.index + reference[1].length;
    return { type: "reference", query: reference[2], start, end: text.length };
  }
  const command = /^\/([^\s/]*)$/.exec(text);
  if (command) return { type: "command", query: command[1], start: 0, end: text.length };
  return undefined;
}

function buildCandidates(catalog: ComposerCatalog, mode: ReturnType<typeof detectMode>, references: AgentReference[]): Candidate[] {
  if (!mode) return [];
  const query = mode.query.toLocaleLowerCase();
  if (mode.type === "command") return catalog.commands
    .filter((command) => command.name.toLocaleLowerCase().includes(query))
    .slice(0, 20)
    .map((command) => ({ type: "command", name: command.name, description: command.description ?? command.source }));
  const exists = new Set(references.map(referenceKey));
  const skills = catalog.skills.map((skill): Candidate => ({ type: "skill", name: skill.name, description: skill.description, reference: { type: "skill", name: skill.name } }));
  const knowledgeBases = catalog.knowledgeBases.map((base): Candidate => ({ type: "knowledge", name: base.name, description: "知识库", reference: { type: "knowledge", id: base.id, name: base.name } }));
  const files = catalog.workspaceEntries.map((entry): Candidate => ({ type: "file", name: entry.path, description: entry.kind === "directory" ? "目录" : "文件", reference: { type: "file", path: entry.path, kind: entry.kind, name: entry.name } }));
  return [...skills, ...knowledgeBases, ...files]
    .filter((candidate) => candidate.name.toLocaleLowerCase().includes(query) && candidate.type !== "command" && !exists.has(referenceKey(candidate.reference)))
    .slice(0, 20);
}

function referenceKey(reference: AgentReference): string {
  return reference.type === "skill" ? `skill:${reference.name}` : reference.type === "knowledge" ? `knowledge:${reference.id}` : `file:${reference.path}`;
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

/** 只移除浏览器为图片剪贴板内容生成的伪文本，不改写真实说明文字。 */
function withoutImagePlaceholders(text: string): string {
  if (!/\[(?:图片|image)\]/iu.test(text)) return text;
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  return text
    .split(/\r?\n/u)
    .filter((line) => !/^\s*\[(?:图片|image)\]\s*$/iu.test(line))
    .map((line) => line.replaceAll(/\[(?:图片|image)\]/giu, ""))
    .join(newline);
}

function supportsDrop(types: readonly string[]): boolean {
  return types.includes("Files") || types.includes("text/plain");
}

function candidateLabel(candidate: Candidate): string {
  if (candidate.type === "skill") return "技能";
  if (candidate.type === "knowledge") return "知识库";
  if (candidate.type === "command") return "命令";
  return candidate.reference.kind === "directory" ? "目录" : "文件";
}
