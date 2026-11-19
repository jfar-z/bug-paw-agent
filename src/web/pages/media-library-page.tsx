import { Film, Images, LibraryBig, Music2, Pencil, Trash2, Upload } from "lucide-react";
import { useEffect, useState } from "react";
import type { MediaCategory, MediaFile, MediaLibrary } from "../../shared/media-library-contracts";
import { api } from "../api";
import { useApiTask } from "../api-task-provider";
import { SecondarySidebarHeader } from "../components/secondary-sidebar-header";
import { useMediaNavigation } from "../layouts/workbench-shell";
import { navigateTo } from "../router";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";
import { useOnlineStatus } from "../use-online-status";
import { MediaDeleteDialog, MediaNameDialog, MediaPreview } from "./media-library-dialogs";
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
type WorkspaceDialog = { kind: "upload" | "delete" } | { kind: "rename" | "preview"; file: MediaFile };

/** 用真实库标识恢复二级导航，加载失败与空列表各自呈现。 */
export function MediaLibraryPage({ libraryId }: { libraryId?: string }) {
  const { runApiTask } = useApiTask();
  const { open, close } = useMediaNavigation();
  const online = useOnlineStatus();
  const [libraries, setLibraries] = useState<LoadState<MediaLibrary>>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [creating, setCreating] = useState(false);
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
      if (event.key === "Escape") dismiss();
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
      ? { status: "ready", items: current.items.map((item) => item.id === library.id ? library : item) }
      : current);
  }

  function removeLibrary(id: string) {
    setLibraries((current) => current.status === "ready"
      ? { status: "ready", items: current.items.filter((library) => library.id !== id) }
      : current);
    select(undefined, true);
  }

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
        {bases.map((base) => <button key={base.id} type="button" className={base.id === libraryId ? "is-active" : undefined}
          aria-current={base.id === libraryId ? "page" : undefined} title={base.name} onClick={() => select(base.id)}>
          <LibraryBig size={16} aria-hidden="true" />
          <span><strong>{base.name}</strong><small>{base.fileCount} 个文件</small></span>
        </button>)}
      </nav>
      {createButton("knowledge-base-navigation__create")}
    </aside>}
    {open && <button type="button" className="knowledge-base-navigation__scrim media-library-scrim" aria-label="关闭媒体库抽屉" onClick={() => {
      close();
      document.querySelector<HTMLButtonElement>(".workbench-secondary-menu")?.focus();
    }} />}
    {selected ? <MediaWorkspace key={selected.id} library={selected} online={online} onLibraryUpdate={updateLibrary}
      onDeleted={() => removeLibrary(selected.id)} onMissing={() => { reload(); }} /> :
      <section className="media-library-landing">
        <div className="knowledge-base-empty-state">
          <img className="knowledge-base-empty-state__image" src="/brand/bugpaw/bugpaw-sleeping.png" alt="" />
          <h1>媒体库</h1>
          {libraries.status === "loading" ? <p role="status">正在读取媒体库…</p> :
            libraries.status === "error" ? <>
              <p role="alert">无法读取媒体库列表。</p>
              <button type="button" className="configuration-secondary-action" onClick={reload}>重新读取媒体库</button>
            </> : libraryId ? <>
              <p role="status">此媒体库已不存在。</p>
              <button type="button" className="configuration-secondary-action" onClick={() => select(undefined, true)}>返回媒体库</button>
            </> : bases.length ? <>
              <p>选择一个媒体库，查看其中的视频、图片和音频。</p>
              <div className="media-library-landing__choices">{bases.map((base) => (
                <button type="button" key={base.id} className="configuration-secondary-action" onClick={() => select(base.id)}>{base.name}</button>
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
  </section>;
}

function MediaWorkspace({ library, online, onDeleted, onLibraryUpdate, onMissing }: {
  library: MediaLibrary;
  online: boolean;
  onDeleted: () => void;
  onLibraryUpdate: (library: MediaLibrary) => void;
  onMissing: () => void;
}) {
  const { runApiTask } = useApiTask();
  const [files, setFiles] = useState<LoadState<MediaFile>>({ status: "loading" });
  const [refresh, setRefresh] = useState(0);
  const [dialog, setDialog] = useState<WorkspaceDialog>();
  const [category, setCategory] = useState<MediaCategory>("video");
  const [notice, setNotice] = useState("");
  const libraryId = library.id;
  const items = files.status === "ready" ? files.items : [];
  const visibleFiles = items.filter((file) => file.category === category);
  const close = () => setDialog(undefined);

  useEffect(() => {
    const controller = new AbortController();
    void runApiTask(() => api.listMediaFiles(libraryId, controller.signal), { operation: "读取库内媒体文件" }).then((result) => {
      if (controller.signal.aborted) return;
      setFiles(result.status === "success" ? { status: "ready", items: result.data.files } : { status: "error" });
    });
    return () => controller.abort();
  }, [libraryId, refresh, runApiTask]);

  function reload() {
    setFiles({ status: "loading" });
    setRefresh((value) => value + 1);
  }

  async function saved(file: MediaFile, uploading: boolean) {
    setCategory(file.category);
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
        <button type="button" data-media-upload className="configuration-primary-action" disabled={!online || files.status === "loading"}
          onClick={() => setDialog({ kind: "upload" })}><Upload size={16} aria-hidden="true" />上传文件</button>
        <button type="button" className="configuration-secondary-action configuration-secondary-action--danger" disabled={!online}
          onClick={() => setDialog({ kind: "delete" })}><Trash2 size={16} aria-hidden="true" />删除媒体库</button>
      </div>
    </header>
    <p className="media-library-status" role="status">{notice}</p>
    <section className="media-library-files" aria-label="库内文件">
      <div className="media-library-categories" role="group" aria-label="媒体类别">
        {categoryOrder.map((key) => {
          const { icon: Icon, label } = categories[key];
          const count = items.filter((file) => file.category === key).length;
          return <button type="button" key={key} className="configuration-secondary-action" aria-pressed={category === key}
            onClick={() => { setCategory(key); setNotice(""); }}>
            <Icon size={16} aria-hidden="true" />{label}{files.status === "ready" && <small>{count}</small>}
          </button>;
        })}
      </div>
      {files.status === "loading" ? <p className="media-library-file-state" role="status">正在读取文件…</p> :
        files.status === "error" ? <div className="media-library-file-state"><p role="alert">无法读取库内文件。</p>
          <button type="button" className="configuration-secondary-action" onClick={reload}>重新读取文件</button></div> :
        visibleFiles.length ? <ul className="media-library-grid">
          {visibleFiles.map((file) => <li key={file.id}>
            <button type="button" className="media-library-file" aria-label={"预览 " + file.name}
              onClick={() => setDialog({ kind: "preview", file })}>
              <MediaThumbnail file={file} />
              <strong title={file.name}>{file.name}</strong>
            </button>
            <button type="button" className="icon-button media-library-rename" disabled={!online} aria-label={"重命名 " + file.name}
              title="重命名" onClick={() => setDialog({ kind: "rename", file })}><Pencil size={16} aria-hidden="true" /></button>
          </li>)}
        </ul> : <div className="media-library-file-state">
          <p>{items.length ? "此类别暂无" + categories[category].label + "。" : "此媒体库尚无文件。"}</p>
          {!items.length && <button type="button" className="configuration-secondary-action" disabled={!online}
            onClick={() => setDialog({ kind: "upload" })}>上传文件</button>}
        </div>}
    </section>
    {dialog?.kind === "upload" && <MediaNameDialog library={library} online={online} onClose={close}
      onSaved={(file) => void saved(file, true)} />}
    {dialog?.kind === "rename" && <MediaNameDialog library={library} file={dialog.file} online={online} onClose={close}
      onSaved={(file) => void saved(file, false)} onRefresh={reload} />}
    {dialog?.kind === "delete" && <MediaDeleteDialog id={library.id} online={online} onClose={close} onDeleted={onDeleted}
      onMissing={onMissing} onLibraryUpdate={onLibraryUpdate} onFilesChanged={reload} />}
    {dialog?.kind === "preview" && <MediaPreview file={dialog.file} onClose={close} />}
  </section>;
}

function MediaThumbnail({ file }: { file: MediaFile }) {
  const [loaded, setLoaded] = useState(false);
  const [failed, setFailed] = useState(false);
  const Icon = categories[file.category].icon;
  return <span className="media-library-thumbnail">
    {!loaded && <Icon size={30} aria-hidden="true" />}
    {file.category !== "audio" && !failed && <img alt="" loading="lazy"
      src={api.mediaFileUrl(file.libraryId, file.id, "thumbnail")}
      className={loaded ? "is-loaded" : undefined} onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />}
  </span>;
}
