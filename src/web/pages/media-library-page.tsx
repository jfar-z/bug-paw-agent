import { Button } from "../ui/controls";
import { Checkbox } from "../ui/choice";
import { Film, Images, LibraryBig, MoreHorizontal, Music2, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { MediaCategory, MediaDeleteItemResult, MediaFile, MediaLibrary } from "../../shared/media-library-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { MediaPreview } from "../components/media-library-preview";
import { MediaFileDeleteDialog } from "../components/media-file-delete-dialog";
import { MediaThumbnail } from "../components/media-thumbnail";
import { SecondarySidebarHeader } from "../ui/sidebar-header";
import { useErrorToast } from "../error-toast-provider";
import { useMediaNavigation } from "../layouts/workbench-shell";
import { navigateTo } from "../router";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";
import { useOnlineStatus } from "../use-online-status";
import { MediaDeleteDialog, MediaLibraryEditDialog, MediaNameDialog } from "./media-library-dialogs";
import "../configuration-dialog.css";
import "../library-workspace.css";
import "../media-library.css";

const categories = {
  video: { label: "视频", icon: Film },
  image: { label: "图片", icon: Images },
  audio: { label: "音频", icon: Music2 },
} satisfies Record<MediaCategory, { label: string; icon: typeof Film }>;
const categoryOrder: MediaCategory[] = ["video", "image", "audio"];

type LoadState<T> = { status: "loading" | "error" } | { status: "ready"; items: T[] };
type WorkspaceDialog = { kind: "upload" } | { kind: "rename" | "preview"; file: MediaFile };

/** 用真实库标识恢复二级导航，加载失败与空列表各自呈现。 */
export function MediaLibraryPage({ libraryId, fileId }: { libraryId?: string; fileId?: string }) {
  const { runApiTask } = useApiTask();
  const { open, close } = useMediaNavigation();
  const online = useOnlineStatus();
  const [libraries, setLibraries] = useState<LoadState<MediaLibrary>>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
  const [libraryAction, setLibraryAction] = useState<{ kind: "edit" | "delete"; id: string }>();
  const [savedLibraryId, setSavedLibraryId] = useState<string>();
  const [filesRevision, setFilesRevision] = useState(0);
  const bases = libraries.status === "ready" ? libraries.items : [];
  const selected = bases.find((base) => base.id === libraryId);

  useEffect(() => {
    const controller = new AbortController();
    void runApiTask(() => api.listMediaLibraries(controller.signal), { operation: "读取媒体库列表" }).then((result) => {
      if (controller.signal.aborted) return;
      setLibraries(result.status === "success" ? { status: "ready", items: result.data.libraries } : { status: "error" });
    });
    return () => controller.abort();
  }, [refresh, runApiTask]);

  useEffect(() => {
    if (!open) return;
    const trigger = document.querySelector<HTMLButtonElement>(".workbench-secondary-menu");
    document.querySelector<HTMLButtonElement>(".media-library-navigation nav button.is-active, .media-library-navigation nav button, .media-library-navigation button[data-media-create]")?.focus();
    const dismiss = () => {
      close();
      trigger?.focus();
    };
    const keydown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !event.defaultPrevented) dismiss();
    };
    const back = (event: Event) => {
      event.preventDefault();
      dismiss();
    };
    window.addEventListener("keydown", keydown);
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, back);
    return () => {
      window.removeEventListener("keydown", keydown);
      window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, back);
    };
  }, [open, close]);

  function select(id?: string, replace = false) {
    if (open) document.querySelector<HTMLButtonElement>(".workbench-secondary-menu")?.focus();
    close();
    navigateTo({ page: "media-library", libraryId: id }, replace);
  }

  function reload() {
    setLibraries({ status: "loading" });
    setRefresh((value) => value + 1);
  }

  function updateLibrary(library: MediaLibrary) {
    setLibraries((current) => current.status === "ready"
      ? { status: "ready", items: current.items.map((item) => item.id === library.id && item.revision <= library.revision ? library : item) }
      : current);
  }

  function removeLibrary(id: string) {
    setLibraries((current) => current.status === "ready"
      ? { status: "ready", items: current.items.filter((library) => library.id !== id) }
      : current);
    if (libraryId === id) select(undefined, true);
  }

  function openLibraryAction(kind: "edit" | "delete", id: string) {
    if (open && window.matchMedia("(max-width: 760px)").matches) {
      document.querySelector<HTMLButtonElement>(".workbench-secondary-menu")?.focus();
    }
    close();
    setSavedLibraryId(undefined);
    setLibraryAction({ kind, id });
  }

  const closeLibraryAction = () => setLibraryAction(undefined);

  const createButton = (className: string) => (
    <button type="button" data-media-create className={className} disabled={!online} onClick={() => {
      if (open) document.querySelector<HTMLButtonElement>(".workbench-secondary-menu")?.focus();
      close();
      setCreating(true);
    }}>创建媒体库</button>
  );

  return <section className={bases.length ? "knowledge-base-page media-library" : "knowledge-base-page knowledge-base-page--empty media-library"}>
    {(bases.length > 0 || open) && <aside className={"knowledge-base-navigation media-library-navigation" + (open ? " is-mobile-open" : "")}>
      <SecondarySidebarHeader eyebrow="MEDIA LIBRARIES" title="媒体库" />
      <nav aria-label="媒体库列表">
        {bases.map((base) => <div className="media-library-nav-row" key={base.id}>
          <button type="button" className={base.id === libraryId ? "is-active" : undefined}
            aria-current={base.id === libraryId ? "page" : undefined} title={base.name} onClick={() => select(base.id)}>
            <LibraryBig size={16} aria-hidden="true" />
            <span><strong>{base.name}</strong><small>{base.fileCount} 个文件</small></span>
          </button>
          <MediaLibraryActions name={base.name} online={online} drawerOpen={open} onAction={(kind) => openLibraryAction(kind, base.id)} />
        </div>)}
      </nav>
      {createButton("knowledge-base-navigation__create")}
    </aside>}
    {open && <button type="button" className="knowledge-base-navigation__scrim media-library-scrim" aria-label="关闭媒体库抽屉" onClick={() => {
      close();
      document.querySelector<HTMLButtonElement>(".workbench-secondary-menu")?.focus();
    }} />}
    {selected ? <MediaWorkspace key={`${selected.id}/${fileId ?? ""}`} library={selected} fileId={fileId} online={online} onLibraryUpdate={updateLibrary}
      filesRevision={filesRevision} librarySaved={savedLibraryId === selected.id} /> :
      <section className="media-library-landing">
        <div className="knowledge-base-empty-state">
          <img className="knowledge-base-empty-state__image" src="/brand/bugpaw/bugpaw-sleeping.png" alt="" />
          <h1>媒体库</h1>
          {libraries.status === "loading" ? <p role="status">正在读取媒体库…</p> :
            libraries.status === "error" ? <>
              <p role="alert">无法读取媒体库列表。</p>
              <Button type="button" className="configuration-secondary-action" onClick={reload}>重新读取媒体库</Button>
            </> : libraryId ? <>
              <p role="status">此媒体库已不存在。</p>
              <Button type="button" className="configuration-secondary-action" onClick={() => select(undefined, true)}>返回媒体库</Button>
            </> : bases.length ? <>
              <p>选择一个媒体库，查看其中的视频、图片和音频。</p>
              <div className="media-library-landing__choices">{bases.map((base) => (
                <Button type="button" key={base.id} className="configuration-secondary-action" onClick={() => select(base.id)}>{base.name}</Button>
              ))}</div>
            </> : <>
              <p>创建媒体库，集中保存视频、图片和音频。</p>
              {createButton("configuration-primary-action")}
            </>}
        </div>
      </section>}
    {creating && <MediaNameDialog online={online} onClose={() => setCreating(false)} onCreated={(library) => {
      setLibraries((current) => ({ status: "ready", items: [...(current.status === "ready" ? current.items : []), library] }));
      setCreating(false);
      select(library.id);
    }} />}
    {libraryAction?.kind === "edit" && <MediaLibraryEditDialog id={libraryAction.id} online={online} onClose={closeLibraryAction}
      onSaved={(updated) => {
        updateLibrary(updated);
        setSavedLibraryId(updated.id);
        closeLibraryAction();
      }} />}
    {libraryAction?.kind === "delete" && <MediaDeleteDialog id={libraryAction.id} online={online} onClose={closeLibraryAction}
      onDeleted={() => { removeLibrary(libraryAction.id); closeLibraryAction(); }}
      onMissing={reload} onLibraryUpdate={updateLibrary}
      onFilesChanged={() => {
        if (libraryAction.id === libraryId) setFilesRevision((current) => current + 1);
      }} />}
  </section>;
}

/** 媒体库行操作沿用会话列表的三点入口，浮层脱离侧栏的滚动区域。 */
function MediaLibraryActions({ name, online, drawerOpen, onAction }: {
  name: string;
  online: boolean;
  drawerOpen: boolean;
  onAction: (kind: "edit" | "delete") => void;
}) {
  const menuId = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const visible = open && online;

  useLayoutEffect(() => {
    const button = trigger.current;
    const panel = menu.current;
    if (!visible || !button || !panel) return;

    const anchor = button.getBoundingClientRect();
    const { width, height } = panel.getBoundingClientRect();
    const margin = 8;
    const gap = 4;
    const below = anchor.bottom + gap;
    const top = below + height <= window.innerHeight - margin ? below : Math.max(margin, anchor.top - gap - height);
    const left = Math.min(Math.max(margin, anchor.right - width), window.innerWidth - margin - width);
    panel.style.top = top + "px";
    panel.style.left = left + "px";
    panel.querySelector("button")?.focus();

    const closeOutside = (event: PointerEvent) => {
      if (event.target instanceof Node && !panel.contains(event.target) && !button.contains(event.target)) setOpen(false);
    };
    const dismiss = () => {
      if (panel.contains(document.activeElement)) button.focus({ preventScroll: true });
      setOpen(false);
    };
    const closeOnScroll = (event: Event) => {
      if (event.target !== panel) dismiss();
    };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", closeOnScroll, true);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", closeOnScroll, true);
    };
  }, [visible]);

  useEffect(() => {
    if (!online) setOpen(false);
  }, [online]);

  useEffect(() => {
    if (!drawerOpen && window.matchMedia("(max-width: 760px)").matches) setOpen(false);
  }, [drawerOpen]);

  function choose(kind: "edit" | "delete") {
    trigger.current?.focus();
    setOpen(false);
    onAction(kind);
  }

  return <>
    <button ref={trigger} type="button" className="icon-button media-library-nav-trigger"
      aria-label={`管理媒体库：${name}`} title="管理媒体库" aria-haspopup="menu" aria-expanded={visible}
      aria-controls={visible ? menuId : undefined} disabled={!online} onClick={() => setOpen((current) => !current)}>
      <MoreHorizontal size={16} aria-hidden="true" />
    </button>
    {visible && createPortal(<div ref={menu} className="media-library-actions" id={menuId} role="menu" aria-label={`管理媒体库：${name}`}
      onKeyDown={(event) => {
        if (event.key === "Escape" || event.key === "Tab") {
          if (event.key === "Escape") event.preventDefault();
          trigger.current?.focus();
          setOpen(false);
        } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = event.currentTarget.querySelectorAll("button");
          const last = event.key === "End" || (event.key.startsWith("Arrow") && document.activeElement === items[0]);
          items[last ? 1 : 0]?.focus();
        }
      }}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => choose("edit")}><Pencil size={15} aria-hidden="true" />编辑媒体库</button>
      <button type="button" role="menuitem" tabIndex={-1} className="is-danger" onClick={() => choose("delete")}><Trash2 size={15} aria-hidden="true" />删除媒体库</button>
    </div>, document.body)}
  </>;
}

function MediaWorkspace({ fileId, library, online, filesRevision, librarySaved, onLibraryUpdate }: {
  library: MediaLibrary;
  fileId?: string;
  online: boolean;
  filesRevision: number;
  librarySaved: boolean;
  onLibraryUpdate: (library: MediaLibrary) => void;
}) {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const [files, setFiles] = useState<LoadState<MediaFile>>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<WorkspaceDialog>();
  const [category, setCategory] = useState<MediaCategory>("video");
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [deleteFiles, setDeleteFiles] = useState<MediaFile[]>();
  const [deleting, setDeleting] = useState(false);
  const [deleteReport, setDeleteReport] = useState<{ message: string; entries: { name: string; result: MediaDeleteItemResult }[] }>();
  const deleteInProgress = useRef(false);
  const categoriesRef = useRef<HTMLDivElement>(null);
  const openedFileLink = useRef(false);
  const libraryId = library.id;
  const items = files.status === "ready" ? files.items : [];
  const visibleFiles = items.filter((file) => file.category === category);
  const selectedFiles = visibleFiles.filter((file) => selected.has(file.id));
  const close = () => setDialog(undefined);

  // 归档链接直接定位原件，刷新后仍可打开同一文件。
  useEffect(() => {
    if (!fileId || files.status !== "ready" || openedFileLink.current) return;
    openedFileLink.current = true;
    const file = files.items.find((entry) => entry.id === fileId);
    if (!file) {
      setNotice("链接指向的媒体文件已不存在。");
      return;
    }
    setCategory(file.category);
    setDialog({ kind: "preview", file });
  }, [fileId, files.status]);

  useEffect(() => {
    const controller = new AbortController();
    void runApiTask(() => api.listMediaFiles(libraryId, controller.signal), { operation: "读取库内媒体文件" }).then((result) => {
      if (controller.signal.aborted) return;
      setFiles(result.status === "success" ? { status: "ready", items: result.data.files } : { status: "error" });
    });
    return () => controller.abort();
  }, [libraryId, refresh, filesRevision, runApiTask]);

  function reload() {
    setFiles({ status: "loading" });
    setRefresh((value) => value + 1);
  }

  function chooseCategory(next: MediaCategory) {
    if (next === category) return;
    setSelected(new Set());
    setDeleteReport(undefined);
    setNotice("");
    setCategory(next);
  }

  function toggleFile(id: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  /** 提交弹窗打开时的版本，逐项保留仍有机会重试的目标。 */
  async function removeFiles() {
    if (!deleteFiles?.length || deleteInProgress.current || !online) return;
    deleteInProgress.current = true;
    setDeleting(true);
    setDeleteReport(undefined);
    setNotice("");
    try {
      const response = await runApiTask(() => api.deleteMediaFiles(libraryId, {
        files: deleteFiles.map(({ id, revision }) => ({ id, revision })),
      }), { operation: "永久删除媒体文件" });
      setDeleteFiles(undefined);
      reload();
      if (response.status === "success") {
        const names = new Map(deleteFiles.map(({ id, name }) => [id, name]));
        const results = response.data.results;
        const deleted = results.filter(({ status }) => status === "deleted").length;
        const missing = results.filter(({ status }) => status === "missing").length;
        const failed = results.filter(({ status }) => status === "failed").length;
        const cleanup = results.filter(({ status }) => status === "cleanup_failed").length;
        const message = "删除成功 " + deleted + " 项，已不存在 " + missing + " 项，删除失败 " + failed + " 项"
          + (cleanup ? "，已不可访问但待清理 " + cleanup + " 项。" : "。");
        const entries = results.filter(({ status }) => status !== "deleted")
          .map((result) => ({ name: names.get(result.id) ?? result.id, result }));
        setDeleteReport({ message, entries });
        setSelected((current) => {
          const next = new Set(current);
          for (const item of results) {
            if (item.status === "failed") next.add(item.id);
            else next.delete(item.id);
          }
          return next;
        });
        const issue = entries.find(({ result }) => result.status === "failed" || result.status === "cleanup_failed");
        if (issue) toast.push({ operation: "永久删除媒体文件", title: "部分媒体文件需要处理",
          summary: issue.name + "：" + issue.result.message, code: issue.result.code });
      }
      requestAnimationFrame(() => {
        if (document.activeElement === document.body) categoriesRef.current?.focus();
      });
      const detail = await runApiTask(() => api.getMediaLibrary(libraryId), { operation: "更新库内文件数量" });
      if (detail.status === "success") onLibraryUpdate(detail.data);
    } finally {
      deleteInProgress.current = false;
      setDeleting(false);
    }
  }

  async function saved(file: MediaFile, uploading: boolean) {
    chooseCategory(file.category);
    setFiles((current) => current.status === "ready"
      ? { status: "ready", items: uploading ? [file, ...current.items] : current.items.map((item) => item.id === file.id ? file : item) }
      : current);
    setNotice(uploading ? "已上传 " + file.name : "当前文件名为 " + file.name);
    close();
    const detail = await runApiTask(() => api.getMediaLibrary(libraryId), { operation: "更新库内文件数量" });
    if (detail.status === "success") onLibraryUpdate(detail.data);
  }

  return <section className="knowledge-base-workspace media-library-workspace">
    <header className="knowledge-base-workspace__heading">
      <div><h1>{library.name}</h1><p>{library.fileCount} 个文件</p></div>
      <div className="knowledge-base-workspace__actions">
        <Button variant="primary" type="button" data-media-upload className="configuration-primary-action" disabled={!online || files.status === "loading"}
          onClick={() => setDialog({ kind: "upload" })}><Upload size={16} aria-hidden="true" />上传文件</Button>
      </div>
    </header>
    {library.note && <section aria-label="媒体库备注">
      <p className="media-library-note">{library.note}</p>
    </section>}
    <p className="media-library-status" role="status">{notice}</p>
    <p className="media-library-status" role="status">{librarySaved ? "媒体库已保存。" : ""}</p>
    {deleteReport && <section className="media-library-note" aria-label="媒体文件删除结果">
      <p role="status">{deleteReport.message}</p>
      {deleteReport.entries.length > 0 && <ul>{deleteReport.entries.map(({ name, result }) => <li key={result.id}>
        {name} · {result.message} · {result.code}
        {result.code === "VERSION_CONFLICT" && "。请核对刷新后的文件名并重新确认。"}
        {result.status === "cleanup_failed" && "。服务重启时会继续回收。"}
      </li>)}</ul>}
    </section>}
    <section className="media-library-files" aria-label="库内文件">
      <div ref={categoriesRef} tabIndex={-1} className="media-library-categories" role="group" aria-label="媒体类别">
        {categoryOrder.map((key) => {
          const { icon: Icon, label } = categories[key];
          const count = items.filter((file) => file.category === key).length;
          return <Button type="button" key={key} className="configuration-secondary-action" aria-pressed={category === key}
            disabled={deleting} onClick={() => chooseCategory(key)}>
            <Icon size={16} aria-hidden="true" />{label}{files.status === "ready" && <small>{count}</small>}
          </Button>;
        })}
        {visibleFiles.length > 0 && <Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger"
          disabled={!online || deleting || !selectedFiles.length || selectedFiles.length > 5000} onClick={() => setDeleteFiles(selectedFiles)}>
          批量删除（已选 {selectedFiles.length} 项）
        </Button>}
      </div>
      {files.status === "loading" ? <p className="media-library-file-state" role="status">正在读取文件…</p> :
        files.status === "error" ? <div className="media-library-file-state"><p role="alert">无法读取库内文件。</p>
          <Button type="button" className="configuration-secondary-action" onClick={reload}>重新读取文件</Button></div> :
        visibleFiles.length ? <ul className="media-library-grid">
          {visibleFiles.map((file) => <li key={file.id}>
            <button type="button" className="media-library-file" aria-label={"预览 " + file.name}
              onClick={() => setDialog({ kind: "preview", file })}>
              <MediaThumbnail file={file} />
              <strong title={file.name}>{file.name}</strong>
            </button>
            <div className="media-library-file-actions">
              <label title="选择文件"><Checkbox aria-label={"选择 " + file.name} checked={selected.has(file.id)}
                disabled={deleting || (!selected.has(file.id) && selectedFiles.length >= 5000)}
                onChange={(event) => toggleFile(file.id, event.target.checked)} /></label>
              <button type="button" className="icon-button" disabled={!online || deleting} aria-label={"重命名 " + file.name}
                title="重命名" onClick={() => setDialog({ kind: "rename", file })}><Pencil size={16} aria-hidden="true" /></button>
              <button type="button" className="icon-button" disabled={!online || deleting} aria-label={"删除 " + file.name}
                title="删除" onClick={() => setDeleteFiles([file])}><Trash2 size={16} aria-hidden="true" /></button>
            </div>
          </li>)}
        </ul> : <div className="media-library-file-state">
          <p>{items.length ? "此类别暂无" + categories[category].label + "。" : "此媒体库尚无文件。"}</p>
          {!items.length && <Button type="button" className="configuration-secondary-action" disabled={!online}
            onClick={() => setDialog({ kind: "upload" })}>上传文件</Button>}
        </div>}
    </section>
    {dialog?.kind === "upload" && <MediaNameDialog library={library} online={online} onClose={close}
      onSaved={(file) => void saved(file, true)} />}
    {dialog?.kind === "rename" && <MediaNameDialog library={library} file={dialog.file} online={online} onClose={close}
      onSaved={(file) => void saved(file, false)} onRefresh={reload} />}
    {dialog?.kind === "preview" && <MediaPreview file={dialog.file} onClose={close} returnFocusSelector="[data-media-upload]" />}
    {deleteFiles && <MediaFileDeleteDialog libraryName={library.name} files={deleteFiles} online={online} busy={deleting}
      onCancel={() => setDeleteFiles(undefined)} onConfirm={() => void removeFiles()} />}
  </section>;
}
