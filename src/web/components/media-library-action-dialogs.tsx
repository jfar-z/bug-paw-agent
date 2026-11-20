import { Eye } from "lucide-react";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { MediaCategory, MediaFile } from "../../shared/media-library-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { useOnlineStatus } from "../use-online-status";
import { ConfigurationEditorDialog } from "./configuration/configuration-editor-dialog";
import { SearchSelect } from "../ui/search-select";
import { MediaLibraryCatalogStatus, useMediaLibraries, type Catalog, type SaveTarget } from "./media-library-actions";
import { MediaPreview } from "./media-library-preview";
import { MediaThumbnail } from "./media-thumbnail";
import "../configuration-dialog.css";
import "./media-library-action-dialogs.css";

function LibraryChoice({ catalog, retry, libraryId, disabled, onChange }: ReturnType<typeof useMediaLibraries> & {
  libraryId: string;
  disabled?: boolean;
  onChange: (id: string) => void;
}) {
  if (catalog.status !== "ready" || !catalog.items.length) return <MediaLibraryCatalogStatus catalog={catalog} retry={retry} />;
  return <SearchSelect ariaLabel="目标媒体库" placeholder="选择媒体库" value={libraryId}
    disabled={disabled} options={catalog.items.map((library) => ({ value: library.id, label: library.name }))} onChange={onChange} />;
}

/** 共用配置弹层的键盘和焦点处理，短视口下只滚动弹层正文。 */
function MediaActionDialog({ title, description, footer, children, busy = false, suspended, onClose }: {
  title: string;
  description: string;
  footer: ReactNode;
  children?: ReactNode;
  busy?: boolean;
  suspended?: boolean;
  onClose: () => void;
}) {
  return <ConfigurationEditorDialog variant="confirmation" title={title} description={description} busy={busy} suspended={suspended} onClose={onClose}
    className="media-action-dialog" footer={footer}>
    <div className="media-action-dialog__body">{children}</div>
  </ConfigurationEditorDialog>;
}

export function PickMediaDialog({ label, category, onClose, onSelect }: {
  label: string;
  category?: MediaCategory;
  onClose: () => void;
  onSelect: (file: MediaFile) => void;
}) {
  const { runApiTask } = useApiTask();
  const libraries = useMediaLibraries();
  const [libraryId, setLibraryId] = useState("");
  const [fileId, setFileId] = useState("");
  const [preview, setPreview] = useState<MediaFile>();
  const previewButton = useRef<HTMLButtonElement>(null);
  const fileGroup = useId();
  const [files, setFiles] = useState<Catalog<MediaFile>>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const selected = files.status === "ready" ? files.items.find((file) => file.id === fileId) : undefined;
  useEffect(() => {
    if (!libraryId) return;
    const controller = new AbortController();
    void runApiTask(() => api.listMediaFiles(libraryId, controller.signal, category), { operation: `读取 ${label} 可用的媒体文件` }).then((result) => {
      if (!controller.signal.aborted) setFiles(result.status === "success"
        ? { status: "ready", items: result.data.files }
        : { status: "error" });
    });
    return () => controller.abort();
  }, [attempt, category, label, libraryId, runApiTask]);
  // 预览独立于选择，关闭后将焦点交还给原文件的预览按钮。
  useEffect(() => {
    if (!preview && previewButton.current) {
      previewButton.current.focus();
      previewButton.current = null;
    }
  }, [preview]);
  return <>
    <MediaActionDialog title="从媒体库选择" description={label} suspended={Boolean(preview)} onClose={onClose} footer={<>
      <button type="button" className="configuration-secondary-action" onClick={onClose}>取消</button>
      <button type="button" className="configuration-primary-action" disabled={!selected} onClick={() => selected && onSelect(selected)}>使用此文件</button>
    </>}>
      <LibraryChoice {...libraries} libraryId={libraryId} onChange={(id) => {
        setLibraryId(id);
        setFileId("");
        setFiles({ status: "loading" });
      }} />
      {libraryId && (files.status === "loading" ? <p role="status">正在读取库内文件…</p>
        : files.status === "error" ? <button type="button" className="configuration-secondary-action" onClick={() => {
          setFiles({ status: "loading" });
          setAttempt((count) => count + 1);
        }}>重新读取库内文件</button>
        : files.items.length === 0 ? <p>当前库没有匹配的文件。</p>
        : <fieldset className="media-picker-files">
          <legend>库内文件</legend>
          {files.items.map((file) => <div className="media-picker-file" key={file.id}>
            <label>
              <input type="radio" name={fileGroup} checked={fileId === file.id} onChange={() => setFileId(file.id)} />
              <MediaThumbnail file={file} iconSize={20} />
              <span>{file.name}</span>
            </label>
            <button type="button" className="icon-button" title="预览" aria-label={`预览 ${file.name}`} onClick={(event) => {
              previewButton.current = event.currentTarget;
              setPreview(file);
            }}><Eye size={18} aria-hidden="true" /></button>
          </div>)}
        </fieldset>)}
    </MediaActionDialog>
    {preview && <MediaPreview file={preview} onClose={() => setPreview(undefined)} />}
  </>;
}

export function SaveMediaDialog({ target, onClose }: { target: SaveTarget; onClose: () => void }) {
  const { runApiTask } = useApiTask();
  const libraries = useMediaLibraries();
  const formId = useId();
  const extensionIndex = target.name.lastIndexOf(".");
  const extension = extensionIndex > 0 ? target.name.slice(extensionIndex) : "";
  const [name, setName] = useState(extensionIndex > 0 ? target.name.slice(0, extensionIndex) : target.name);
  const [libraryId, setLibraryId] = useState("");
  const [conflict, setConflict] = useState("");
  const [saved, setSaved] = useState<MediaFile>();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const online = useOnlineStatus();
  const library = libraries.catalog.status === "ready" ? libraries.catalog.items.find((entry) => entry.id === libraryId) : undefined;
  async function save() {
    if (!online || pending.current || !library || !name.trim()) return;
    pending.current = true;
    setBusy(true);
    setConflict("");
    const result = await runApiTask(() => api.saveMediaResult(library.id, {
      source: target.source, taskId: target.taskId, assetId: target.assetId, name: name.trim() + extension,
    }), { operation: `保存 ${target.name} 到媒体库`, expected: { MEDIA_NAME_CONFLICT: (error) => setConflict(error.message) } });
    if (result.status === "success") setSaved(result.data);
    pending.current = false;
    setBusy(false);
  }
  return <MediaActionDialog title={saved ? "已保存到媒体库" : "保存到媒体库"}
    description={saved ? `${library?.name} · ${saved.name}` : target.name}
    busy={busy} onClose={onClose} footer={<>
      <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onClose}>{saved ? "关闭" : "取消"}</button>
      {saved ? <a className="configuration-primary-action"
        href={`/media-library/${encodeURIComponent(saved.libraryId)}?file=${encodeURIComponent(saved.id)}`}>查看已保存文件</a>
        : <button type="submit" form={formId} className="configuration-primary-action"
          disabled={busy || !online || !library || !name.trim()}>{busy ? "正在保存…" : "保存"}</button>}
    </>}>
    {!saved && <form id={formId} className="media-action-dialog__body" onSubmit={(event) => { event.preventDefault(); void save(); }}>
      <LibraryChoice {...libraries} libraryId={libraryId} disabled={busy} onChange={(id) => { setLibraryId(id); setConflict(""); }} />
      <label>文件名<input value={name} disabled={busy} onChange={(event) => { setName(event.target.value); setConflict(""); }} /></label>
      {extension && <small>保留扩展名 {extension}</small>}
      {conflict && <p role="alert">{conflict}，请改名或换库。</p>}
    </form>}
  </MediaActionDialog>;
}

export function MediaPublicTransferDialog({ message, onClose, onConfirm, disabled }: {
  message: string;
  onClose: () => void;
  onConfirm: () => void;
  disabled?: boolean;
}) {
  return <MediaActionDialog title="确认将媒体副本用于公网传输"
    description="Grok 将通过公网地址读取本次执行的媒体副本。取得该地址的人可访问副本，媒体库原件仍受登录保护。"
    onClose={onClose} footer={<>
      <button type="button" className="configuration-secondary-action" onClick={onClose}>取消</button>
      <button type="button" className="configuration-primary-action" disabled={disabled} onClick={onConfirm}>确认并运行</button>
    </>}>
    <p>{message}</p>
  </MediaActionDialog>;
}
