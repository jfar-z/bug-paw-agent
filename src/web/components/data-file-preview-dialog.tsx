import { Download, FileQuestion } from "lucide-react";
import { useEffect, useState, type CSSProperties } from "react";
import type { DataFileSummary, DataFileTextPreview } from "../../shared/contracts";
import { api, dataFileUrl } from "../api";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";
import { Dialog } from "../ui/dialog";
import { formatFileSize } from "./attachment-picker";

interface DataFilePreviewDialogProps {
  agentId: string;
  path: string;
  onClose(): void;
}

/** 按需读取 Markdown 文件链接，并在隔离弹窗中预览。 */
export function DataFilePreviewDialog({ agentId, path, onClose }: DataFilePreviewDialogProps) {
  const [summary, setSummary] = useState<DataFileSummary>();
  const [text, setText] = useState<DataFileTextPreview>();
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setSummary(undefined);
    setText(undefined);
    setError("");
    void api.getDataFile(agentId, path).then((file) => {
      if (!active) return;
      setSummary(file);
      if (isTextPreview(file)) {
        void api.getDataFileText(agentId, file.path).then((preview) => {
          if (active) setText(preview);
        }).catch((reason: unknown) => {
          if (active) setError(errorMessage(reason));
        });
      }
    }).catch((reason: unknown) => {
      if (active) setError(errorMessage(reason));
    });
    return () => { active = false; };
  }, [agentId, path]);

  useEffect(() => {
    // 移动端系统返回与弹层的键盘关闭共用同一个回调。
    const onMobileBack = (event: Event) => {
      event.preventDefault();
      onClose();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBack);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBack);
  }, [onClose]);

  const source = summary ? dataFileUrl(agentId, summary.path) : "";
  return <Dialog className="data-file-preview-dialog" title={summary?.name ?? "正在读取文件"}
    closeLabel="关闭文件预览" onClose={onClose}
    headerActions={summary ? <a className="bp-button bp-button--icon" href={dataFileUrl(agentId, summary.path, true)}
      download={summary.name} aria-label={`下载 ${summary.name}`} title="下载文件"><Download size={17} aria-hidden="true" /></a> : null}>
      {summary ? <small style={styles.meta}>{formatFileSize(summary.size)} · {summary.mediaType}</small> : null}
      <div style={styles.body}>
        {error ? <div style={styles.empty} role="alert"><FileQuestion size={28} aria-hidden="true" /><p>{error}</p></div> : null}
        {!error && !summary ? <p style={styles.empty}>正在读取文件信息…</p> : null}
        {summary?.mediaType.startsWith("image/") && summary.mediaType !== "image/svg+xml" ? <img style={styles.media} src={source} alt={summary.name} /> : null}
        {summary?.mediaType === "image/svg+xml" ? <iframe style={styles.frame} src={source} title={`${summary.name} SVG 预览`} sandbox="" /> : null}
        {summary?.mediaType.startsWith("video/") ? <video style={styles.media} src={source} controls autoPlay={false} preload="metadata" /> : null}
        {summary?.mediaType.startsWith("audio/") ? <audio style={styles.audio} src={source} controls preload="metadata" /> : null}
        {summary?.mediaType === "application/pdf" ? <iframe style={styles.frame} src={source} title={`${summary.name} PDF 预览`} /> : null}
        {summary?.mediaType === "text/html" ? <iframe style={styles.frame} src={source} title={`${summary.name} HTML 预览`} sandbox="" /> : null}
        {summary && isTextPreview(summary) && summary.mediaType !== "text/html" && summary.mediaType !== "image/svg+xml" ? text
          ? <div style={styles.textPreview}><pre style={styles.pre}>{text.content}</pre>{text.truncated ? <p style={styles.notice}>仅展示前 512 KiB。</p> : null}</div>
          : !error ? <p style={styles.empty}>正在读取文本内容…</p> : null
          : null}
        {summary && !isPreviewable(summary) ? <div style={styles.empty}><FileQuestion size={28} aria-hidden="true" /><p>当前格式不支持在线预览，可以下载后查看。</p></div> : null}
      </div>
  </Dialog>;
}

const styles: Record<string, CSSProperties> = {
  meta: { color: "var(--text-tertiary)", fontFamily: "var(--font-mono)", fontSize: 10 },
  body: { display: "grid", gridRow: "-2 / -1", minHeight: 0, placeItems: "center", background: "var(--surface-soft)", overflow: "auto" },
  media: { display: "block", maxWidth: "100%", maxHeight: "100%", objectFit: "contain" },
  audio: { width: "min(620px, calc(100% - 40px))" },
  frame: { width: "100%", height: "100%", border: 0, background: "#fff" },
  textPreview: { alignSelf: "stretch", justifySelf: "stretch", display: "grid", minHeight: "100%", gridTemplateRows: "1fr auto" },
  pre: { margin: 0, padding: 20, color: "var(--text-primary)", font: "12px/1.65 var(--font-mono)", whiteSpace: "pre-wrap", overflowWrap: "anywhere" },
  empty: { display: "grid", maxWidth: 420, justifyItems: "center", gap: 10, padding: 24, color: "var(--text-secondary)", textAlign: "center" },
  notice: { position: "sticky", bottom: 0, margin: 0, padding: "8px 16px", borderTop: "1px solid var(--border)", color: "var(--text-tertiary)", background: "var(--surface)", fontSize: 11 },
};

function isTextPreview(file: DataFileSummary): boolean {
  return file.mediaType.startsWith("text/") || /\.(md|mdx|json|ya?ml|toml|ini|csv|tsx?|jsx?|css|xml|py|java|go|rs|sh|sql|log)$/i.test(file.name);
}

function isPreviewable(file: DataFileSummary): boolean {
  return file.mediaType.startsWith("image/") || file.mediaType.startsWith("video/") || file.mediaType.startsWith("audio/")
    || file.mediaType === "application/pdf" || isTextPreview(file);
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : "文件无法预览";
}
