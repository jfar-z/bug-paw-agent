import { Table } from "../ui/table";
import { ConfirmDialog } from "../ui/dialog";
import { Checkbox } from "../ui/choice";
import { SearchField, Button, IconButton, TextField } from "../ui/controls";
import { Eye, File, FileAudio, FileImage, FileText, FileVideo, Folder, FolderPlus, MoveRight, Pencil, Trash2, Upload, type LucideIcon } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from "react";
import type { WorkspaceEntry, WorkspaceTextPreview } from "../../shared/contracts";
import { api, workspaceFileUrl } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { useOnlineStatus } from "../use-online-status";
import { locateWorkspaceReference } from "../workspace-links";
import { WorkspaceFilePreview } from "./workspace-file-preview";

export interface WorkspaceLocationRequest {
  id: number;
  path: string;
}

export interface WorkspaceBrowserDataSource {
  /** 切换数据源时用于重置浏览状态的稳定标识。 */
  key: string;
  rootLabel: string;
  searchPlaceholder: string;
  showHiddenToggle?: boolean;
  listEntries: (directory: string, includeHidden: boolean) => Promise<{ entries: WorkspaceEntry[] }>;
  searchEntries: (query: string, includeHidden: boolean) => Promise<{ entries: WorkspaceEntry[] }>;
  getText: (path: string) => Promise<WorkspaceTextPreview>;
  uploadFiles: (directory: string, files: File[]) => Promise<unknown>;
  createDirectory: (directory: string, name: string) => Promise<unknown>;
  updateEntry: (body: { operation: "rename"; path: string; name: string } | { operation: "move"; path: string; targetDirectory: string; createTargetDirectory?: boolean }) => Promise<unknown>;
  deleteEntries: (paths: string[]) => Promise<void>;
  fileUrl: (entry: WorkspaceEntry, download: boolean) => string;
}

interface WorkspaceBrowserProps {
  agentId: string;
  mode: "page" | "quick";
  heading?: ReactNode;
  locationRequest?: WorkspaceLocationRequest;
  onPreviewOpenChange?: (open: boolean) => void;
  previewCloseRequest?: number;
  dataSource?: WorkspaceBrowserDataSource;
}

/** 为独立资源页和快捷抽屉提供固定 Agent 的同一套文件管理能力。 */
export function WorkspaceBrowser({ agentId, mode, heading, locationRequest, onPreviewOpenChange, previewCloseRequest, dataSource }: WorkspaceBrowserProps) {
  const { runApiTask } = useApiTask();
  const online = useOnlineStatus();
  const [directory, setDirectory] = useState("");
  const [query, setQuery] = useState("");
  const [includeHidden, setIncludeHidden] = useState(false);
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [selectedPaths, setSelectedPaths] = useState<string[]>([]);
  const [preview, setPreview] = useState<WorkspaceEntry>();
  const [highlightedPath, setHighlightedPath] = useState("");
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const deletionPending = useRef(false);
  const [moveEntry, setMoveEntry] = useState<WorkspaceEntry>();
  const [moveTargetDirectory, setMoveTargetDirectory] = useState("");
  const [moveConfirmationOpen, setMoveConfirmationOpen] = useState(false);
  const [moveSubmitting, setMoveSubmitting] = useState(false);
  const [renameEntry, setRenameEntry] = useState<WorkspaceEntry>();
  const [renameValue, setRenameValue] = useState("");
  const [createDirectoryOpen, setCreateDirectoryOpen] = useState(false);
  const [directoryName, setDirectoryName] = useState("");
  const [error, setError] = useState("");
  const refreshGenerationRef = useRef(0);
  const locationGenerationRef = useRef(0);
  const sourceKey = dataSource?.key ?? agentId;
  const hasSource = Boolean(dataSource || agentId);
  const rootLabel = dataSource?.rootLabel ?? "工作目录";
  const searchPlaceholder = dataSource?.searchPlaceholder ?? "搜索当前 Agent 的全部文件";
  // 快捷抽屉内的滚动边界也必须交出横向触摸，才能让外层结算关闭手势。
  const quickScrollStyle: CSSProperties | undefined = mode === "quick" ? { touchAction: "pan-y" } : undefined;

  const refreshEntries = async () => {
    const generation = ++refreshGenerationRef.current;
    if (!hasSource) {
      setEntries([]);
      return;
    }
    try {
      setError("");
      const result = query.trim()
        ? await (dataSource?.searchEntries(query.trim(), includeHidden) ?? api.searchWorkspaceEntries(agentId, query.trim(), includeHidden))
        : await (dataSource?.listEntries(directory, includeHidden) ?? api.listWorkspaceEntries(agentId, directory, includeHidden));
      if (generation === refreshGenerationRef.current) setEntries(result.entries);
    } catch (reason) {
      if (generation === refreshGenerationRef.current) {
        await runApiTask(async () => { throw reason; }, { operation: "加载工作区文件", expected: workspaceExpected(setError) });
      }
    }
  };

  useEffect(() => {
    setDirectory("");
    setQuery("");
    setSelectedPaths([]);
    setPreview(undefined);
    setHighlightedPath("");
    setError("");
  }, [sourceKey]);
  useEffect(() => { void refreshEntries(); }, [sourceKey, directory, query, includeHidden]);
  useEffect(() => {
    if (!locationRequest || !hasSource) return;
    const generation = ++locationGenerationRef.current;
    setQuery("");
    setSelectedPaths([]);
    setHighlightedPath("");
    setError("");
    void locateWorkspaceReference(locationRequest.path, async (targetDirectory) => {
      const result = await (dataSource?.listEntries(targetDirectory, includeHidden) ?? api.listWorkspaceEntries(agentId, targetDirectory, includeHidden));
      return result.entries;
    }).then((location) => {
      if (generation !== locationGenerationRef.current) return;
      setDirectory(location.directory);
      if (location.kind === "file") {
        setEntries((current) => current.some((entry) => entry.path === location.entry.path) ? current : [...current, location.entry]);
        setHighlightedPath(location.entry.path);
        setPreview(location.entry);
      } else {
        setPreview(undefined);
      }
      if (location.kind === "missing") setError(`未找到引用文件：${location.path}`);
    }).catch(async (reason) => {
      if (generation !== locationGenerationRef.current) return;
      await runApiTask(async () => { throw reason; }, { operation: "定位工作区文件", expected: workspaceExpected(setError) });
    });
  }, [sourceKey, includeHidden, locationRequest?.id]);
  useEffect(() => onPreviewOpenChange?.(Boolean(preview)), [onPreviewOpenChange, preview]);
  useEffect(() => {
    if (previewCloseRequest !== undefined) setPreview(undefined);
  }, [previewCloseRequest]);

  const resetLocationState = () => {
    setQuery("");
    setSelectedPaths([]);
    setPreview(undefined);
    setHighlightedPath("");
  };
  const enterDirectory = (path: string) => {
    setDirectory(path);
    resetLocationState();
  };
  const toggleSelection = (path: string) => setSelectedPaths((current) => current.includes(path) ? current.filter((item) => item !== path) : [...current, path]);
  const openCreateDirectoryDialog = () => {
    setDirectoryName("");
    setCreateDirectoryOpen(true);
  };
  const confirmCreateDirectory = async () => {
    if (!directoryName.trim()) return;
    const result = await runApiTask(() => dataSource?.createDirectory(directory, directoryName.trim()) ?? api.createWorkspaceDirectory(agentId, directory, directoryName.trim()), { operation: "创建文件夹", expected: workspaceExpected(setError) });
    if (result.status === "success") {
      setCreateDirectoryOpen(false);
      await refreshEntries();
    }
  };
  const openRenameDialog = (entry: WorkspaceEntry) => {
    setRenameEntry(entry);
    setRenameValue(entry.name);
  };
  const confirmRenameEntry = async () => {
    if (!renameEntry || !renameValue.trim() || renameValue.trim() === renameEntry.name) return;
    const result = await runApiTask(() => dataSource?.updateEntry({ operation: "rename", path: renameEntry.path, name: renameValue.trim() }) ?? api.updateWorkspaceEntry(agentId, { operation: "rename", path: renameEntry.path, name: renameValue.trim() }), { operation: "重命名文件", expected: workspaceExpected(setError) });
    if (result.status === "success") {
      setRenameEntry(undefined);
      await refreshEntries();
    }
  };
  const openMoveDialog = (entry: WorkspaceEntry) => {
    setMoveEntry(entry);
    setMoveTargetDirectory("");
    setMoveConfirmationOpen(false);
  };
  const moveEntryToDirectory = async (createTargetDirectory: boolean) => {
    if (!moveEntry || moveSubmitting) return;
    setMoveSubmitting(true);
    setError("");
    try {
      const body = {
        operation: "move",
        path: moveEntry.path,
        targetDirectory: moveTargetDirectory.trim(),
        ...(createTargetDirectory ? { createTargetDirectory: true } : {}),
      } as const;
      const result = await runApiTask(() => dataSource?.updateEntry(body) ?? api.updateWorkspaceEntry(agentId, body), {
        operation: "移动文件",
        expected: {
          ...workspaceExpected(setError),
          NOT_FOUND: () => {
            if (!createTargetDirectory) setMoveConfirmationOpen(true);
            else setError("目标目录创建后仍不可用");
          },
        },
      });
      if (result.status === "success") {
        setMoveEntry(undefined);
        setMoveConfirmationOpen(false);
        await refreshEntries();
      }
    } finally {
      setMoveSubmitting(false);
    }
  };
  const uploadFiles = async (files: FileList | null) => {
    if (!files?.length) return;
    const result = await runApiTask(() => dataSource?.uploadFiles(directory, [...files]) ?? api.uploadWorkspaceFiles(agentId, directory, [...files]), { operation: "上传文件", expected: workspaceExpected(setError) });
    if (result.status === "success") await refreshEntries();
  };
  const deleteSelected = async () => {
    if (!online || !selectedPaths.length || deletionPending.current) return;
    // 确认过程中保留所选路径，防止重复提交。
    deletionPending.current = true;
    setDeleting(true);
    try {
      const result = await runApiTask(() => dataSource?.deleteEntries(selectedPaths) ?? api.deleteWorkspaceEntries(agentId, selectedPaths), { operation: "删除文件", expected: workspaceExpected(setError) });
      if (result.status === "success") {
        setSelectedPaths([]);
        setPreview(undefined);
        setDeleteOpen(false);
        await refreshEntries();
      }
    } finally {
      deletionPending.current = false;
      setDeleting(false);
    }
  };
  const handleDirectoryRowClick = (event: MouseEvent<HTMLTableRowElement>, entry: WorkspaceEntry) => {
    if (entry.kind !== "directory") return;
    const target = event.target as HTMLElement;
    if (target.closest(".workspace-entry-select, .workspace-entry-actions-cell, button, a, input")) return;
    enterDirectory(entry.path);
  };

  const main = <section className={mode === "page" ? "workspace-resources-page__main" : "workspace-browser workspace-browser--quick"} style={quickScrollStyle}>
    {heading}
    {error ? <p className="configuration-inline-error">{error}</p> : null}
    {hasSource ? <>
      <div className="workspace-resources-page__toolbar">
        <SearchField className="workspace-search" label="搜索文件名" placeholder={searchPlaceholder} value={query} onChange={setQuery} />
        {dataSource?.showHiddenToggle === false ? null : <label className="workspace-hidden-toggle"><Checkbox checked={includeHidden} onChange={(event) => setIncludeHidden(event.target.checked)} />显示隐藏文件</label>}
        <label className="configuration-secondary-action workspace-upload" aria-disabled={!online}><Upload size={15} aria-hidden="true" />上传<input type="file" multiple disabled={!online} onChange={(event) => void uploadFiles(event.target.files)} /></label>
        <Button type="button" className="configuration-secondary-action" disabled={!online} onClick={openCreateDirectoryDialog}><FolderPlus size={15} aria-hidden="true" />新建文件夹</Button>
        <Button variant="danger" disabled={!online || !selectedPaths.length} icon={<Trash2 aria-hidden />} onClick={() => setDeleteOpen(true)}>删除所选 {selectedPaths.length} 项</Button>
      </div>
      {!query && <nav className="workspace-breadcrumb" aria-label="当前目录"><button type="button" onClick={() => enterDirectory("")}>{rootLabel}</button>{directory.split("/").filter(Boolean).map((segment, index, all) => <button type="button" key={`${segment}-${index}`} onClick={() => enterDirectory(all.slice(0, index + 1).join("/"))}>/ {segment}</button>)}</nav>}
      <Table label={`${rootLabel}文件`} layout="scroll" className="workspace-table-wrap" style={quickScrollStyle}
        hidden={mode === "quick" && Boolean(preview)} rows={entries} rowKey={(entry) => entry.path}
        rowProps={(entry) => ({
          className: entry.path === highlightedPath ? "is-reference-target" : undefined,
          onClick: (event) => handleDirectoryRowClick(event, entry),
        })}
        columns={[
          { id: "select", label: "选择", className: "workspace-entry-select", cell: (entry) =>
            <Checkbox aria-label={`选择 ${entry.name}`} checked={selectedPaths.includes(entry.path)} onChange={() => toggleSelection(entry.path)} /> },
          { id: "name", label: "名称", className: "workspace-entry-name-cell", cell: (entry) =>
            entry.kind === "directory" ? <Button variant="ghost" className="workspace-entry-name"
              aria-label={`进入 ${entry.name}`} onClick={() => enterDirectory(entry.path)}>
              <WorkspaceEntryIcon entry={entry} /><span className="workspace-entry-name__label" title={entry.name}>{entry.name}</span>
            </Button> : <span className="workspace-entry-name"><WorkspaceEntryIcon entry={entry} />
              <span className="workspace-entry-name__label" title={entry.name}>{entry.name}</span>
            </span> },
          { id: "path", label: "路径", cell: (entry) => <code>{entry.path}</code> },
          { id: "size", label: "大小", cell: (entry) => entry.size === undefined ? "—" : formatFileSize(entry.size) },
          { id: "modified", label: "修改时间", cell: (entry) => new Date(entry.modifiedAt).toLocaleString() },
          { id: "actions", label: "操作", className: "workspace-entry-actions-cell", cell: (entry) =>
            <div className="workspace-entry-actions">
              {entry.kind === "file" && <>
                <IconButton size="sm" label={`预览 ${entry.name}`} onClick={() => setPreview(entry)}><Eye /></IconButton>
                <a href={dataSource?.fileUrl(entry, true) ?? workspaceFileUrl(agentId, entry.path, true)} download={entry.name}>下载</a>
              </>}
              <IconButton size="sm" label={`重命名 ${entry.name}`} disabled={!online} onClick={() => openRenameDialog(entry)}><Pencil /></IconButton>
              <IconButton size="sm" label={`移动 ${entry.name}`} disabled={!online} onClick={() => openMoveDialog(entry)}><MoveRight /></IconButton>
            </div> },
        ]} />
      {mode === "quick" && preview ? <WorkspaceFilePreview agentId={agentId} entry={preview} mode="overlay" onClose={() => setPreview(undefined)} fileUrl={dataSource?.fileUrl} getText={dataSource?.getText} /> : null}
    </> : null}
  </section>;

  return <>{main}
    {mode === "page" && preview ? <WorkspaceFilePreview agentId={agentId} entry={preview} mode="side" onClose={() => setPreview(undefined)} fileUrl={dataSource?.fileUrl} getText={dataSource?.getText} /> : null}
    {renameEntry ? <div className="workspace-dialog-backdrop"><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-rename-title"><h2 id="workspace-rename-title">重命名文件</h2><p>修改“{renameEntry.name}”的名称。</p><label className="workspace-dialog__field" htmlFor="workspace-rename-value">新名称<TextField id="workspace-rename-value" aria-label="新名称" value={renameValue} onChange={(event) => setRenameValue(event.target.value)} autoFocus /></label><footer><button type="button" onClick={() => setRenameEntry(undefined)}>取消</button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || !renameValue.trim() || renameValue.trim() === renameEntry.name} onClick={() => void confirmRenameEntry()}>确认重命名</Button></footer></section></div> : null}
    {createDirectoryOpen ? <div className="workspace-dialog-backdrop"><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-create-directory-title"><h2 id="workspace-create-directory-title">新建文件夹</h2><p>将在当前目录中创建新的文件夹。</p><label className="workspace-dialog__field" htmlFor="workspace-directory-name">文件夹名称<TextField id="workspace-directory-name" aria-label="文件夹名称" value={directoryName} placeholder="例如 drafts" onChange={(event) => setDirectoryName(event.target.value)} autoFocus /></label><footer><button type="button" onClick={() => setCreateDirectoryOpen(false)}>取消</button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || !directoryName.trim()} onClick={() => void confirmCreateDirectory()}>确认新建</Button></footer></section></div> : null}
    {moveEntry ? <div className="workspace-dialog-backdrop"><section className="workspace-dialog" role="dialog" aria-modal="true" aria-labelledby="workspace-move-title"><h2 id="workspace-move-title">移动文件</h2><p>将“{moveEntry.name}”移动到指定目录。</p>{moveConfirmationOpen ? <><p>目录“{moveTargetDirectory.trim()}”不存在。</p><small>确认后将创建该目录及其缺失的父目录，再移动文件。</small><footer><button type="button" disabled={moveSubmitting} onClick={() => setMoveConfirmationOpen(false)}>返回修改</button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || moveSubmitting} onClick={() => void moveEntryToDirectory(true)}>创建并移动</Button></footer></> : <><label className="workspace-dialog__field" htmlFor="workspace-move-target">目标目录<TextField id="workspace-move-target" aria-label="目标目录" value={moveTargetDirectory} placeholder="例如 docs/archive" onChange={(event) => setMoveTargetDirectory(event.target.value)} autoFocus /></label><small>留空表示移动到工作目录根部。</small><footer><button type="button" disabled={moveSubmitting} onClick={() => setMoveEntry(undefined)}>取消</button><Button variant="primary" type="button" className="configuration-primary-action" disabled={!online || moveSubmitting} onClick={() => void moveEntryToDirectory(false)}>确认移动</Button></footer></>}</section></div> : null}
    {deleteOpen && <ConfirmDialog title="永久删除文件"
      description={`${selectedPaths.length} 个项目将被永久删除，无法恢复。`}
      busy={deleting} confirmDisabled={!online} confirmLabel="永久删除"
      onCancel={() => setDeleteOpen(false)} onConfirm={() => void deleteSelected()}>
      {error && <p role="alert">{error}</p>}
    </ConfirmDialog>}
  </>;
}

/** 将工作区路径、上传和冲突错误保留在对应操作附近。 */
function workspaceExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return { INVALID_PATH: show, FILE_NOT_FOUND: show, CONFLICT: show, UNSAFE_LINK: show, TEXT_PREVIEW_UNAVAILABLE: show, WORKSPACE_SCAN_LIMIT: show, INVALID_MULTIPART: show, EMPTY_UPLOAD: show };
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "ico", "bmp", "avif"]);
const AUDIO_EXTENSIONS = new Set(["mp3", "wav", "m4a", "aac", "ogg", "flac"]);
const VIDEO_EXTENSIONS = new Set(["mp4", "mov", "mkv", "avi", "webm"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "md", "mdx", "rtf", "csv", "odt", "ods", "odp"]);

/** 根据资源类型及文件名后缀选择列表图标。 */
function workspaceEntryIcon(entry: WorkspaceEntry): LucideIcon {
  if (entry.kind === "directory") return Folder;
  const extension = entry.name.slice(entry.name.lastIndexOf(".") + 1).toLowerCase();
  if (IMAGE_EXTENSIONS.has(extension)) return FileImage;
  if (AUDIO_EXTENSIONS.has(extension)) return FileAudio;
  if (VIDEO_EXTENSIONS.has(extension)) return FileVideo;
  if (DOCUMENT_EXTENSIONS.has(extension)) return FileText;
  return File;
}

function WorkspaceEntryIcon({ entry }: { entry: WorkspaceEntry }) {
  const Icon = workspaceEntryIcon(entry);
  return <Icon size={17} style={{ flexShrink: 0 }} aria-hidden="true" />;
}

function formatFileSize(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}
