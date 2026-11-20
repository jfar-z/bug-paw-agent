import { ChevronLeft, Download, Maximize2, Minimize2, X } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { WorkspaceEntry, WorkspaceTextPreview } from "../../shared/contracts";
import { api, workspaceFileUrl } from "../api";
import { useApiTask } from "../api-task-provider";
import { Button, IconButton } from "../ui/controls";

interface WorkspaceFilePreviewProps {
  agentId: string;
  entry: WorkspaceEntry;
  mode: "side" | "overlay";
  onClose: () => void;
  returnFocus?: HTMLElement | null;
  fileUrl?: (entry: WorkspaceEntry, download: boolean) => string;
  allowHtmlPreview?: boolean;
  getText?: (path: string) => Promise<WorkspaceTextPreview>;
}

/**
 * 在资源管理页中按文件类型展示只读媒体或文本预览。
 */
export function WorkspaceFilePreview({ agentId, entry, mode, onClose, returnFocus, fileUrl, getText, allowHtmlPreview = true }: WorkspaceFilePreviewProps) {
  const { runApiTask } = useApiTask();
  const [text, setText] = useState<WorkspaceTextPreview>();
  const [error, setError] = useState("");
  const [htmlView, setHtmlView] = useState<"page" | "source">("page");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const previewRef = useRef<HTMLElement>(null);
  const mediaType = entry.mediaType ?? "application/octet-stream";
  const resolveFileUrl = fileUrl ?? ((item: WorkspaceEntry, download: boolean) => workspaceFileUrl(agentId, item.path, download));
  const source = resolveFileUrl(entry, false);
  const isHtml = allowHtmlPreview && (mediaType === "text/html" || entry.name.toLowerCase().endsWith(".html"));
  const isMedia = mediaType.startsWith("image/") || mediaType.startsWith("video/") || mediaType.startsWith("audio/");
  // 预览层及其内容区均可能成为滚动边界，需要继续支持横划返回资源列表。
  const previewStyle: CSSProperties | undefined = mode === "overlay"
    ? { width: "100%", minWidth: 0, height: "100%", zIndex: 2, touchAction: "pan-y", ...(isFullscreen ? { border: 0 } : {}) }
    : isFullscreen ? { width: "100%", minWidth: 0, height: "100%", border: 0 } : undefined;
  const previewBodyStyle: CSSProperties = { flex: 1, ...(mode === "overlay" ? { touchAction: "pan-y" } : {}) };

  useLayoutEffect(() => {
    const preview = previewRef.current;
    const trigger = returnFocus ?? document.activeElement;
    preview?.querySelector<HTMLElement>("[data-preview-close]")?.focus({ preventScroll: true });
    return () => {
      if (!(trigger instanceof HTMLElement) || !preview) return;
      if (document.activeElement !== document.body && !preview.contains(document.activeElement)) return;
      // 覆盖和窄屏布局先恢复文件列表，再交还焦点，避免聚焦尚未显示的文件行。
      requestAnimationFrame(() => {
        if (trigger.isConnected && document.activeElement === document.body) trigger.focus({ preventScroll: true });
      });
    };
  }, [returnFocus]);

  useEffect(() => {
    if (isMedia || (isHtml && htmlView === "page")) return;
    let active = true;
    setText(undefined);
    setError("");
    const loadText = getText ?? ((path: string) => api.getWorkspaceText(agentId, path));
    loadText(entry.path).then((content) => {
      if (active) setText(content);
    }).catch(async (reason) => {
      if (!active) return;
      await runApiTask(async () => { throw reason; }, {
        operation: "预览工作区文件",
        expected: {
          TEXT_PREVIEW_UNAVAILABLE: (error) => setError(error.message),
          FILE_NOT_FOUND: (error) => setError(error.message),
          INVALID_PATH: (error) => setError(error.message),
        },
      });
    });
    return () => { active = false; };
  }, [agentId, entry.path, getText, htmlView, isHtml, isMedia, runApiTask]);

  useEffect(() => {
    setHtmlView("page");
  }, [entry.path]);

  useEffect(() => {
    const updateFullscreenState = () => setIsFullscreen(document.fullscreenElement === previewRef.current);
    updateFullscreenState();
    document.addEventListener("fullscreenchange", updateFullscreenState);
    return () => document.removeEventListener("fullscreenchange", updateFullscreenState);
  }, []);

  const toggleFullscreen = () => {
    if (!previewRef.current) return;
    const operation = document.fullscreenElement === previewRef.current
      ? document.exitFullscreen?.()
      : previewRef.current.requestFullscreen?.();
    if (operation) {
      // 全屏失败不关闭普通预览，但必须向用户展示浏览器拒绝的具体原因。
      void runApiTask(() => operation, { operation: isFullscreen ? "退出文件全屏预览" : "进入文件全屏预览" });
    }
  };

  return <aside ref={previewRef} className={`workspace-file-preview workspace-file-preview--${mode}`} style={previewStyle} aria-label={`${entry.name} 预览`}>
    <header>
      <strong title={entry.name}>{entry.name}</strong>
      <span className="workspace-file-preview__actions">
        {isHtml && <Button aria-label={htmlView === "page" ? "查看源码" : "查看页面"} onClick={() => setHtmlView((current) => current === "page" ? "source" : "page")}>{htmlView === "page" ? "源码" : "页面"}</Button>}
        <IconButton label={isFullscreen ? "退出全屏预览" : "全屏预览"} onClick={toggleFullscreen}>
          {isFullscreen ? <Minimize2 /> : <Maximize2 />}
        </IconButton>
        <IconButton label={mode === "overlay" ? "返回文件列表" : "关闭预览"} data-preview-close onClick={onClose}>
          {mode === "overlay" ? <ChevronLeft /> : <X />}
        </IconButton>
      </span>
    </header>
    <div className="workspace-file-preview__body" style={previewBodyStyle}>
      {mediaType.startsWith("image/") ? <img src={source} alt={entry.name} /> : null}
      {mediaType.startsWith("video/") ? <video src={source} controls /> : null}
      {mediaType.startsWith("audio/") ? <audio src={source} controls /> : null}
      {isHtml && htmlView === "page" ? <iframe title={`${entry.name} 页面预览`} src={source} sandbox="allow-scripts" style={{ display: "block", width: "100%", minHeight: "100%", border: 0, background: "#fff" }} /> : null}
      {!isMedia && (!isHtml || htmlView === "source") ? <>{error ? <p className="configuration-inline-error">{error}</p> : text ? <><pre>{text.content}</pre>{text.truncated ? <p>仅展示前 512 KiB。</p> : null}</> : <p>正在读取文本预览…</p>}</> : null}
    </div>
    <a href={resolveFileUrl(entry, true)} download={entry.name}><Download size={15} aria-hidden="true" />下载文件</a>
  </aside>;
}
