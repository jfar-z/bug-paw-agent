import { Minus, Plus, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { MEDIA_FORMATS, MEDIA_LIBRARY_NOTE_MAX_LENGTH, MEDIA_UPLOAD_BYTES, type MediaFile, type MediaLibrary } from "../../shared/media-library-contracts";
import { api, type ApiClientError } from "../api";
import { toUnexpectedErrorNotice } from "../api-error-policy";
import { useApiTask } from "../api-task-provider";
import { ConfigurationEditorDialog } from "../components/configuration/configuration-editor-dialog";
import { useErrorToast } from "../error-toast-provider";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";

const formats = Object.keys(MEDIA_FORMATS);

type MediaNameDialogProps = { online: boolean; onClose: () => void } & (
  | { library?: undefined; onCreated: (library: MediaLibrary) => void }
  | { library: MediaLibrary; file?: MediaFile; onSaved: (file: MediaFile) => void; onRefresh?: () => void }
);

function splitName(name: string) {
  const index = name.lastIndexOf(".");
  return index > 0 ? { stem: name.slice(0, index), extension: name.slice(index) } : { stem: name, extension: "" };
}

function showApiError(error: ApiClientError) {
  return [error.message, error.code, error.requestId].filter(Boolean).join(" · ");
}

/** 创建、上传和改名复用编辑控件，文件操作始终保留原扩展名。 */
export function MediaNameDialog(props: MediaNameDialogProps) {
  const { library, online, onClose } = props;
  const { runApiTask } = useApiTask();
  const editingFile = props.library ? props.file : undefined;
  const [existing, setExisting] = useState(editingFile);
  const [upload, setUpload] = useState<File>();
  const [stem, setStem] = useState(() => splitName(editingFile?.name ?? "").stem);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const submitting = useRef(false);
  const formId = useId();
  const uploading = !!library && !editingFile;
  const extension = splitName(existing?.name ?? upload?.name.trim() ?? "").extension;
  const title = uploading ? "上传文件" : editingFile ? "重命名文件" : "创建媒体库";
  const action = uploading ? "上传" : editingFile ? "保存名称" : "创建媒体库";

  function chooseFile(file?: File) {
    setUpload(file);
    setStem(splitName(file?.name.trim() ?? "").stem);
    setError("");
  }

  async function submit() {
    if (!online || submitting.current) return;
    setError("");
    const cleaned = stem.trim().normalize("NFC");
    const name = cleaned + extension;
    if (!cleaned || name.length > 200 || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(cleaned) || /^\.+$/.test(cleaned)) {
      setError("请输入有效名称。总长度须在 200 字符以内，且不能包含路径分隔符、控制字符或非法标点。");
      return;
    }
    if (uploading && (!upload || !formats.includes(extension.toLowerCase()) || upload.size > MEDIA_UPLOAD_BYTES || upload.size === 0)) {
      setError(!upload ? "请选择要上传的文件。" : upload.size > MEDIA_UPLOAD_BYTES ? "每个媒体文件最大 50 MiB。" :
        upload.size === 0 ? "所选文件为空，请选择有内容的媒体文件。" : "请选择 JPEG、PNG、MP4 或 MP3 文件。");
      return;
    }

    submitting.current = true;
    setBusy(true);
    try {
      const expected = { VALIDATION_FAILED: (error: ApiClientError) => setError(showApiError(error)),
        MEDIA_NAME_CONFLICT: (error: ApiClientError) => setError(showApiError(error)) };
      if (!props.library) {
        const result = await runApiTask(() => api.createMediaLibrary(name), { operation: title, expected });
        if (result.status === "success") props.onCreated(result.data);
        return;
      }
      const id = props.library.id;
      if (existing?.name === name) {
        onClose();
        return;
      }
      const preflight = await runApiTask(() => api.checkMediaName(id, name, existing?.id), { operation: "检查库内重名", expected });
      if (preflight.status !== "success") return;
      if (!preflight.data.available) {
        setError("此媒体库已存在同名文件，请修改文件名。");
        return;
      }
      const result = await runApiTask(
        () => existing
          ? api.renameMediaFile(id, existing.id, { name, revision: existing.revision })
          : api.uploadMediaFile(id, upload!, name),
        { operation: title, expected: {
          ...expected,
          MEDIA_UPLOAD_LIMIT: (error) => setError(showApiError(error)),
          MEDIA_FORMAT_UNSUPPORTED: (error) => setError(showApiError(error)),
          MEDIA_FILE_INVALID: (error) => setError(showApiError(error)),
          MEDIA_UPLOAD_BUSY: (error) => setError(showApiError(error)),
          VERSION_CONFLICT: (error) => setError(showApiError(error)),
        } },
      );
      if (result.status === "success") props.onSaved(result.data);
      if (existing && result.status === "handled" && result.error.code === "VERSION_CONFLICT") {
        const latest = await runApiTask(() => api.getMediaFile(id, existing.id), { operation: "读取更新后的媒体文件" });
        if (latest.status === "success") setExisting(latest.data);
        props.onRefresh?.();
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <ConfigurationEditorDialog variant="confirmation" className="media-library-dialog" title={title}
    description={uploading ? "保存到“" + library.name + "”。支持 JPEG、PNG、MP4、MP3，单个文件最大 50 MiB，图片最多 6400 万像素。" :
      editingFile ? "编辑主文件名。扩展名会保留。" : "输入名称来创建一个空媒体库。"}
    busy={busy} onClose={onClose} returnFocusSelector={library ? "[data-media-upload]" : "[data-media-create]"}
    footer={<>
      <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" form={formId} className="configuration-primary-action" disabled={busy || !online || (uploading && !upload)}>
        {busy ? uploading ? "正在上传并处理…" : "正在保存…" : action}
      </button>
    </>}>
    <form id={formId} noValidate className="media-library-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {uploading && <label>选择文件<input type="file" accept={formats.join(",")} disabled={busy} onChange={(event) => chooseFile(event.target.files?.[0])} /></label>}
      <label>{library ? "主文件名" : "媒体库名称"}
        <span className="media-library-name">
          <input value={stem} disabled={busy || (uploading && !upload)} aria-invalid={!!error || undefined}
            aria-describedby={error ? formId + "-error" : undefined}
            onChange={(event) => { setStem(event.target.value); setError(""); }} />
          {extension && <span>{extension}</span>}
        </span>
      </label>
      {busy && uploading && <p role="status">正在发送文件并等待服务端生成预览。</p>}
      {error && <p id={formId + "-error"} className="configuration-inline-error" role="alert">{error}</p>}
    </form>
  </ConfigurationEditorDialog>;
}

type LibraryEditSnapshot = { status: "loading" | "error" | "missing" } | { status: "ready"; library: MediaLibrary };

/** 编辑弹层以最新库版本初始化草稿，并要求用户确认冲突后的版本。 */
export function MediaLibraryEditDialog({ id, online, onClose, onSaved }: {
  id: string;
  online: boolean;
  onClose: () => void;
  onSaved: (library: MediaLibrary) => void;
}) {
  const { runApiTask } = useApiTask();
  const toast = useErrorToast();
  const [snapshot, setSnapshot] = useState<LibraryEditSnapshot>({ status: "loading" });
  const [retry, setRetry] = useState(0);
  const [conflict, setConflict] = useState("");
  const [draft, setDraft] = useState<{ name: string; note: string }>();
  const [busy, setBusy] = useState(false);
  const [fieldError, setFieldError] = useState<{ field: "name" | "note"; message: string }>();
  const submitting = useRef(false);
  const nameInput = useRef<HTMLInputElement>(null);
  const formId = useId();

  useEffect(() => {
    const controller = new AbortController();
    void runApiTask(() => api.getMediaLibrary(id, controller.signal), {
      operation: "读取媒体库编辑信息",
      expected: { NOT_FOUND: (error) => {
        if (!controller.signal.aborted) toast.push(toUnexpectedErrorNotice(error, "读取媒体库编辑信息"));
      } },
    }).then((result) => {
      if (controller.signal.aborted) return;
      if (result.status === "success") {
        const library = result.data;
        // 初次读取填写草稿。冲突时仅替换版本快照，保留用户输入。
        setDraft((current) => current ?? { name: library.name, note: library.note });
        setSnapshot({ status: "ready", library });
      } else {
        setSnapshot({ status: result.status === "handled" && result.error.code === "NOT_FOUND" ? "missing" : "error" });
        if (result.status === "handled" && result.error.code === "AUTH_REQUIRED") {
          toast.push(toUnexpectedErrorNotice(result.error, "读取媒体库编辑信息"));
        }
      }
    });
    return () => controller.abort();
  }, [id, retry, runApiTask, toast]);

  useEffect(() => {
    const back = (event: Event) => {
      event.preventDefault();
      if (!submitting.current) onClose();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, back);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, back);
  }, [onClose]);

  function reload() {
    setSnapshot({ status: "loading" });
    setRetry((value) => value + 1);
  }

  async function submit() {
    if (!online || submitting.current || conflict || !draft || snapshot.status !== "ready") return;
    submitting.current = true;
    setBusy(true);
    setFieldError(undefined);
    try {
      const operation = "保存媒体库";
      const result = await runApiTask(() => api.updateMediaLibrary(id, { ...draft, revision: snapshot.library.revision }), {
        operation,
        expected: {
          VALIDATION_FAILED: (error) => {
            const field = error.details?.field;
            if (field === "name" || field === "note") setFieldError({ field, message: showApiError(error) });
            else toast.push(toUnexpectedErrorNotice(error, operation));
          },
          VERSION_CONFLICT: (error) => { setConflict(showApiError(error)); reload(); },
          NOT_FOUND: (error) => {
            setSnapshot({ status: "missing" });
            toast.push(toUnexpectedErrorNotice(error, operation));
          },
        },
      });
      if (result.status === "success") onSaved(result.data);
      if (result.status === "handled" && result.error.code === "AUTH_REQUIRED") {
        toast.push(toUnexpectedErrorNotice(result.error, operation));
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  function renderFieldError(field: "name" | "note") {
    return fieldError?.field === field &&
      <p id={formId + "-" + field} className="configuration-inline-error" role="alert">{fieldError.message}</p>;
  }

  return <ConfigurationEditorDialog variant="confirmation" className="media-library-dialog" title="编辑媒体库"
    description={"备注可留空，最多 " + MEDIA_LIBRARY_NOTE_MAX_LENGTH + " 个字符。"}
    busy={busy} onClose={onClose} returnFocusSelector="[data-media-edit]"
    footer={<>
      <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" form={formId} className="configuration-primary-action"
        disabled={busy || !online || snapshot.status !== "ready" || !!conflict}>{busy ? "正在保存…" : "保存"}</button>
    </>}>
    <form id={formId} className="media-library-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {snapshot.status === "loading" && <p role="status">正在读取最新媒体库信息…</p>}
      {snapshot.status === "missing" && <p role="alert">此媒体库已不存在，无法保存。</p>}
      {snapshot.status === "error" && <button type="button" className="configuration-secondary-action" disabled={!online}
        onClick={reload}>重新读取媒体库</button>}
      {conflict && <p role="alert">{conflict}。请查看最新库信息，确认后再保存草稿。</p>}
      {conflict && snapshot.status === "ready" && <div>
        <p>最新名称：{snapshot.library.name}</p>
        <p className="media-library-note">最新备注：{snapshot.library.note || "无"}</p>
        <button type="button" className="configuration-secondary-action" onClick={() => {
          setConflict("");
          nameInput.current?.focus();
        }}>已核对，继续编辑</button>
      </div>}
      {draft && <>
        <label>媒体库名称
          <input ref={nameInput} value={draft.name} disabled={busy} aria-invalid={fieldError?.field === "name" || undefined}
            aria-describedby={fieldError?.field === "name" ? formId + "-name" : undefined}
            onChange={(event) => {
              setDraft({ ...draft, name: event.target.value });
              if (fieldError?.field === "name") setFieldError(undefined);
            }} />
        </label>
        {renderFieldError("name")}
        <label>媒体库备注
          <textarea rows={4} value={draft.note} disabled={busy} aria-invalid={fieldError?.field === "note" || undefined}
            aria-describedby={fieldError?.field === "note" ? formId + "-note" : undefined}
            onChange={(event) => {
              setDraft({ ...draft, note: event.target.value });
              if (fieldError?.field === "note") setFieldError(undefined);
            }} />
        </label>
        {renderFieldError("note")}
      </>}
    </form>
  </ConfigurationEditorDialog>;
}

/** 每次打开都读取删除范围。版本变化时刷新范围并清空确认名称。 */
export function MediaDeleteDialog({ id, online, onClose, onDeleted, onMissing, onLibraryUpdate, onFilesChanged }: {
  id: string;
  online: boolean;
  onClose: () => void;
  onDeleted: () => void;
  onMissing: () => void;
  onLibraryUpdate: (library: MediaLibrary) => void;
  onFilesChanged: () => void;
}) {
  const { runApiTask } = useApiTask();
  const [scope, setScope] = useState<MediaLibrary>();
  const [loading, setLoading] = useState(true);
  const [retry, setRetry] = useState(0);
  const [busy, setBusy] = useState(false);
  const [name, setName] = useState("");
  const [changed, setChanged] = useState(false);
  const formId = useId();
  const submitting = useRef(false);
  const canDelete = !!scope && name === scope.name && online && !busy && !loading;

  useEffect(() => {
    let active = true;
    void runApiTask(() => api.getMediaLibrary(id), { operation: "读取待删除媒体库的范围" }).then((result) => {
      if (!active) return;
      if (result.status === "success") setScope(result.data);
      setLoading(false);
    });
    return () => { active = false; };
  }, [id, retry, runApiTask]);

  async function remove() {
    if (!canDelete || !scope || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const { name, revision, fileCount } = scope;
      const result = await runApiTask(() => api.deleteMediaLibrary(id, { name, revision, fileCount }), {
        operation: "永久删除媒体库",
        expected: { VERSION_CONFLICT: () => {
          setName("");
          setScope(undefined);
          setChanged(true);
        } },
      });
      if (result.status === "success") {
        onDeleted();
        return;
      }

      // 清理原件失败时事务可能已提交，通过详情确认界面应保留还是移除该库。
      const latest = await runApiTask(() => api.getMediaLibrary(id), {
        operation: "核对媒体库删除结果",
        expected: { NOT_FOUND: onMissing },
      });
      if (latest.status === "success") {
        setScope(latest.data);
        onLibraryUpdate(latest.data);
        if (latest.data.revision !== revision) {
          setName("");
          setChanged(true);
          onFilesChanged();
        }
      } else {
        setScope(undefined);
        setName("");
      }
    } finally {
      submitting.current = false;
      setBusy(false);
    }
  }

  return <ConfigurationEditorDialog variant="confirmation" className="media-library-dialog" title="永久删除媒体库"
    description="媒体库及其中的所有视频、图片和音频都将永久删除，且无法恢复。"
    busy={busy} onClose={onClose} returnFocusSelector="[data-media-create]"
    footer={<>
      <button type="button" className="configuration-secondary-action" disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" form={formId} className="configuration-secondary-action configuration-secondary-action--danger"
        disabled={!canDelete}>{busy ? "正在删除…" : "永久删除媒体库"}</button>
    </>}>
    <form id={formId} className="media-library-form" onSubmit={(event) => { event.preventDefault(); void remove(); }}>
      {changed && <p role="alert">库内文件或媒体库信息已变化。请检查更新后的范围并重新输入库名确认。</p>}
      {loading ? <p role="status">正在读取删除范围…</p> : scope ? <>
        <p>“{scope.name}”包含 {scope.fileCount} 个文件。</p>
        <label>输入媒体库名称以确认
          <input value={name} disabled={busy} onChange={(event) => setName(event.target.value)} />
        </label>
      </> : <button type="button" className="configuration-secondary-action" onClick={() => {
        setLoading(true);
        setRetry((value) => value + 1);
      }}>重新读取删除范围</button>}
    </form>
  </ConfigurationEditorDialog>;
}

/** 原件仅在弹层打开时请求，卸载播放器即停止播放。 */
export function MediaPreview({ file, onClose }: { file: MediaFile; onClose: () => void }) {
  const toast = useErrorToast();
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [zoom, setZoom] = useState(1);
  const [natural, setNatural] = useState({ width: 0, height: 0 });
  const [viewport, setViewport] = useState({ width: 0, height: 0 });
  const stage = useRef<HTMLDivElement>(null);
  const player = useRef<HTMLMediaElement | null>(null);
  const source = api.mediaFileUrl(file.libraryId, file.id, "content");
  const playable = file.category !== "image";
  const fittedRatio = Math.min(1, viewport.width / natural.width, viewport.height / natural.height);
  const ratio = zoom === 1 ? fittedRatio : zoom === 2 ? Math.max(1, fittedRatio * 2) : Math.max(2, fittedRatio * 4);

  useEffect(() => {
    const element = stage.current;
    if (!element) return;
    const media = player.current;
    const observer = new ResizeObserver(() => setViewport({ width: element.clientWidth, height: element.clientHeight }));
    observer.observe(element);
    return () => {
      observer.disconnect();
      media?.pause();
    };
  }, []);

  useEffect(() => {
    const back = (event: Event) => { event.preventDefault(); onClose(); };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, back);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, back);
  }, [onClose]);

  function failed(media?: MediaError | null) {
    setState("error");
    const stage = media?.code === 3 || media?.code === 4 ? "解码或播放" : "读取原件";
    toast.push(toUnexpectedErrorNotice(new Error(stage + "未完成" + (media ? "（媒体错误 " + media.code + "）" : "")), "预览 " + file.name));
  }

  return <ConfigurationEditorDialog variant="confirmation" className="media-library-preview" title={file.name}
    description="媒体预览" busy={false} onClose={onClose} returnFocusSelector="[data-media-upload]"
    footer={<>
      {!playable && <div className="media-library-zoom" role="group" aria-label="图片缩放">
          <button type="button" className="icon-button" aria-label="缩小图片" disabled={zoom === 1 || state !== "ready"}
            onClick={() => setZoom(zoom - 1)}><Minus size={18} aria-hidden="true" /></button>
          <button type="button" className="configuration-secondary-action" disabled={zoom === 1} onClick={() => setZoom(1)}>
            {zoom === 1 ? "完整显示" : "恢复完整显示"}
          </button>
          <button type="button" className="icon-button" aria-label="放大图片" disabled={zoom === 3 || state !== "ready"}
            onClick={() => setZoom(zoom + 1)}><Plus size={18} aria-hidden="true" /></button>
      </div>}
      <button type="button" className="configuration-secondary-action" onClick={onClose}><X size={18} aria-hidden="true" />关闭预览</button>
    </>}>
    <div className={"media-library-preview__stage" + (!playable && zoom === 1 ? " is-fitted" : "")} ref={stage} tabIndex={zoom > 1 ? 0 : undefined}
      role="region" aria-label="媒体内容">
      {state === "loading" && <p role="status">正在读取媒体…</p>}
      {state === "error" ? <p role="alert">无法{playable ? "读取或播放" : "读取"}“{file.name}”。</p> : file.category === "image" ? (
        <img src={source} alt={file.name} className={state === "ready" ? "is-loaded" : undefined}
          style={natural.width && viewport.width ? { width: natural.width * ratio, height: natural.height * ratio } : undefined}
          onLoad={(event) => {
            const { naturalWidth, naturalHeight } = event.currentTarget;
            setNatural({ width: naturalWidth, height: naturalHeight });
            setState("ready");
          }} onError={() => failed()} />
      ) : file.category === "video" ? (
        <video ref={(element) => { player.current = element; }} src={source} controls playsInline preload="metadata" aria-label={file.name}
          onLoadedMetadata={() => setState("ready")} onError={(event) => failed(event.currentTarget.error)} />
      ) : <audio ref={(element) => { player.current = element; }} src={source} controls preload="metadata" aria-label={file.name}
        onLoadedMetadata={() => setState("ready")} onError={(event) => failed(event.currentTarget.error)} />}
    </div>
  </ConfigurationEditorDialog>;
}
