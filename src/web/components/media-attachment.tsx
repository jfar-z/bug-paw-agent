import { Download, FileText } from "lucide-react";
import { useEffect, useState } from "react";
import type { WorkspaceFileRef, WorkspaceFileSummary } from "../../shared/contracts";
import { api, workspaceFileUrl } from "../api";
import { useApiTask } from "../api-task-provider";
import { formatFileSize } from "./attachment-picker";

interface MediaAttachmentProps {
  file: WorkspaceFileRef | WorkspaceFileSummary;
  agentId?: string;
  onResolved?: (summary: WorkspaceFileSummary) => void;
  onPreview?: (summary: WorkspaceFileSummary) => void;
}

/**
 * 根据工作目录相对路径恢复实时元数据，展示媒体预览和下载入口。
 */
export function MediaAttachment({ file, agentId = "default", onResolved, onPreview }: MediaAttachmentProps) {
  const { runApiTask } = useApiTask();
  const [summary, setSummary] = useState<WorkspaceFileSummary | undefined>(() => isWorkspaceFileSummary(file) ? file : undefined);
  const [unavailable, setUnavailable] = useState(false);

  useEffect(() => {
    if (isWorkspaceFileSummary(file)) {
      setSummary(file);
      setUnavailable(false);
      return;
    }
    let active = true;
    setSummary(undefined);
    setUnavailable(false);
    void runApiTask(() => api.getWorkspaceFile(agentId, file.path), {
      operation: "读取附件信息",
      expected: { FILE_NOT_FOUND: () => { if (active) setUnavailable(true); } },
    }).then((result) => {
      if (active && result.status === "success") setSummary(result.data);
    });
    return () => {
      active = false;
    };
  }, [agentId, file, runApiTask]);

  useEffect(() => {
    if (summary) onResolved?.(summary);
  }, [onResolved, summary]);

  const name = summary?.name ?? file.path.split("/").at(-1) ?? file.path;
  const previewUrl = workspaceFileUrl(agentId, file.path);
  const mediaType = summary?.mediaType ?? "application/octet-stream";
  const media = mediaType.startsWith("image/")
    ? onPreview && summary
      ? <button type="button" className="media-attachment__open" aria-label={`全屏预览 ${name}`} onClick={(event) => {
        // 触控激活在部分浏览器中不聚焦按钮，显式指定弹层的回焦入口。
        event.currentTarget.focus({ preventScroll: true });
        onPreview(summary);
      }}><img src={previewUrl} alt={name} loading="lazy" /></button>
      : <img src={previewUrl} alt={name} loading="lazy" />
      : mediaType.startsWith("audio/")
      ? <audio src={previewUrl} controls preload="metadata" />
      : mediaType.startsWith("video/")
      ? <video src={previewUrl} controls preload="metadata" />
        : (
          <div className="media-attachment__file">
            <FileText size={22} aria-hidden="true" />
          </div>
        );

  return (
    <figure className={`media-attachment media-attachment--${mediaKind(mediaType)}`}>
      <div className="media-attachment__preview">{media}</div>
      <figcaption>
        <span>
          <strong>{name}</strong>
          <small>{unavailable ? "文件不可用" : summary ? formatFileSize(summary.size) : "读取中"}</small>
          <small>{file.path}</small>
        </span>
        <a href={workspaceFileUrl(agentId, file.path, true)} download={name} aria-label={`下载 ${name}`} title="下载附件">
          <Download size={15} aria-hidden="true" />
        </a>
      </figcaption>
    </figure>
  );
}

function isWorkspaceFileSummary(file: WorkspaceFileRef | WorkspaceFileSummary): file is WorkspaceFileSummary {
  return "mediaType" in file && "size" in file && "name" in file;
}

function mediaKind(mediaType: string): string {
  return mediaType.split("/", 1)[0] || "file";
}
