import { ConfirmDialog } from "../ui/dialog";
import { AlertTriangle } from "lucide-react";

import type { SessionBulkPreview } from "../api";

interface SessionBulkConfirmationDialogProps {
  preview: SessionBulkPreview;
  busy?: boolean;
  onCancel(): void;
  onConfirm(): void;
}

/** 展示会话批量归档或删除的稳定预览及定时任务影响。 */
export function SessionBulkConfirmationDialog({ preview, busy = false, onCancel, onConfirm }: SessionBulkConfirmationDialogProps) {
  const deleting = preview.action === "delete";
  const restoring = preview.action === "restore";
  const verb = deleting ? "删除" : restoring ? "恢复" : "归档";
  const confirmLabel = deleting && preview.tasks.length > 0
    ? "删除会话并停用任务"
    : restoring ? "恢复全部会话" : `${verb}会话`;
  return (
    <ConfirmDialog title={`确认${verb} ${preview.sessionCount} 个会话`} confirmLabel={confirmLabel}
      description={restoring ? "恢复后，这些会话将重新出现在会话列表。" : "确认后将一次性处理已选择的会话。"}
      busy={busy} destructive={deleting} onCancel={onCancel} onConfirm={onConfirm}>
      {preview.tasks.length > 0 ? <div role="alert">
        <strong><AlertTriangle size={16} aria-hidden="true" /> 检测到 {preview.tasks.length} 个定时任务</strong>
        <p>{deleting
          ? "继续删除会同步停用这些任务；任务记录会保留并标记原目标已删除，重新启用前必须重新选择目标。"
          : restoring
            ? "这些定时任务将保持原启用状态和原目标，不会因恢复会话而改变。"
            : "这些任务仍保持启用并继续运行，目标会话归档状态不会阻止定时执行。"}</p>
      </div> : <p>未检测到绑定的定时任务。</p>}
    </ConfirmDialog>
  );
}
