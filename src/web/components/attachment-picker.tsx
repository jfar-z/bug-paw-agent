import { File, LoaderCircle, Paperclip, X } from "lucide-react";
import type { WorkspaceFileSummary } from "../../shared/contracts";
import { FilePickerButton, IconButton } from "../ui/controls";

export interface AttachmentUploadItem {
  localId: string;
  file: File;
  status: "uploading" | "uploaded" | "error" | "missing";
  workspaceFile?: WorkspaceFileSummary;
  error?: string;
}

interface AttachmentPickerProps {
  items: AttachmentUploadItem[];
  disabled?: boolean;
  maxFiles?: number;
  maxFileSize?: number;
  showButton?: boolean;
  onFilesSelected: (files: File[]) => void;
  onRemove: (localId: string) => void;
  onError: (message: string) => void;
}

/**
 * 负责附件选择边界与待发送状态展示，上传动作由对话页统一协调。
 */
export function AttachmentPicker({
  items,
  disabled,
  maxFiles = 5,
  maxFileSize = 100 * 1024 * 1024,
  showButton = true,
  onFilesSelected,
  onRemove,
  onError,
}: AttachmentPickerProps) {
  return (
    <div className="attachment-picker">
      {items.length > 0 && (
        <div className="attachment-picker__items" aria-label="待发送附件">
          {items.map((item) => (
            <div className={`attachment-upload-item is-${item.status}`} key={item.localId}>
              {item.status === "uploading" ? <LoaderCircle className="is-spinning" size={15} aria-hidden="true" /> : <File size={15} aria-hidden="true" />}
              <span><strong>{item.file.name}</strong><small>{statusText(item)}</small></span>
              <IconButton size="sm" label={`移除 ${item.file.name}`} onClick={() => onRemove(item.localId)} disabled={disabled || item.status === "uploading"}>
                <X size={14} aria-hidden="true" />
              </IconButton>
            </div>
          ))}
        </div>
      )}
      {showButton ? <AttachmentPickerButton items={items} disabled={disabled} maxFiles={maxFiles} maxFileSize={maxFileSize} onFilesSelected={onFilesSelected} onError={onError} /> : null}
    </div>
  );
}

/** 仅渲染附件上传触发器，以便嵌入输入框的固定操作轨。 */
export function AttachmentPickerButton({
  items,
  disabled,
  maxFiles = 5,
  maxFileSize = 100 * 1024 * 1024,
  onFilesSelected,
  onError,
}: Omit<AttachmentPickerProps, "onRemove" | "showButton">) {
  function selectFiles(files: File[]): void {
    const validationError = validateAttachmentSelection(items.length, files, maxFiles, maxFileSize);
    if (validationError) {
      onError(validationError);
      return;
    }
    onFilesSelected(files);
  }

  return <FilePickerButton
    className="attachment-picker__button"
    label="添加附件"
    title="添加图片、音视频或文件"
    icon={<Paperclip size={17} />}
    multiple
    disabled={disabled}
    onFilesSelected={selectFiles}
  />;
}

/** 统一校验文件选择、剪贴板与拖放入口的附件边界。 */
export function validateAttachmentSelection(
  currentCount: number,
  files: File[],
  maxFiles = 5,
  maxFileSize = 100 * 1024 * 1024,
): string | undefined {
  if (currentCount + files.length > maxFiles) return `单次消息最多添加 ${maxFiles} 个附件。`;
  const oversized = files.find((file) => file.size > maxFileSize);
  return oversized ? `${oversized.name} 超过单文件大小限制。` : undefined;
}

function statusText(item: AttachmentUploadItem): string {
  if (item.status === "uploading") {
    return "上传中";
  }
  if (item.status === "error") {
    return item.error ?? "上传失败";
  }
  if (item.status === "missing") return item.error ?? "历史附件已失效";
  return formatFileSize(item.file.size);
}

export function formatFileSize(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${Math.round(size / 1024)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}
