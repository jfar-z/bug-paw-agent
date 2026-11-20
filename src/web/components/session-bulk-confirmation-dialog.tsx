import { Button } from "../ui/controls";
import { AlertTriangle, Archive, ArchiveRestore, Trash2 } from "lucide-react";

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
  const titleId = "session-bulk-confirmation-title";
  return (
    <div className="configuration-dialog-backdrop session-bulk-dialog-backdrop" role="presentation">
      <section className="configuration-dialog session-bulk-dialog" style={{ width: "min(520px, 100%)", display: "grid", gap: 16 }} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header>
          <span className={deleting ? "session-bulk-dialog__icon is-destructive" : "session-bulk-dialog__icon"} style={{ color: deleting ? "var(--danger)" : "var(--accent-strong)" }}>
            {deleting
              ? <Trash2 size={20} aria-hidden="true" />
              : restoring
                ? <ArchiveRestore size={20} aria-hidden="true" />
                : <Archive size={20} aria-hidden="true" />}
          </span>
          <div>
            <h2 id={titleId}>确认{verb} {preview.sessionCount} 个会话</h2>
            <p>{restoring
              ? "恢复后，这些会话将重新出现在会话列表。"
              : "确认后将一次性处理已选择的会话。"}</p>
          </div>
        </header>
        {preview.tasks.length > 0 ? <div className={`session-bulk-dialog__task-warning${deleting ? " is-destructive" : ""}`} style={{ display: "flex", gap: 10, padding: 12, border: `${deleting ? 2 : 1}px solid ${deleting ? "var(--danger)" : "var(--accent)"}`, borderRadius: 11, color: deleting ? "var(--danger)" : "var(--accent-strong)", background: deleting ? "color-mix(in srgb, var(--danger) 10%, var(--surface))" : "var(--accent-soft)" }} role="alert">
          <AlertTriangle size={18} aria-hidden="true" />
          <div>
            <strong>检测到 {preview.tasks.length} 个定时任务</strong>
            <p>{deleting
              ? "继续删除会同步停用这些任务；任务记录会保留并标记原目标已删除，重新启用前必须重新选择目标。"
              : restoring
                ? "这些定时任务将保持原启用状态和原目标，不会因恢复会话而改变。"
                : "这些任务仍保持启用并继续运行，目标会话归档状态不会阻止定时执行。"}</p>
          </div>
        </div> : <p className="session-bulk-dialog__plain-impact">未检测到绑定的定时任务。</p>}
        <footer>
          <Button type="button" className="configuration-secondary-action" disabled={busy} onClick={onCancel}>取消</Button>
          <button type="button" className={deleting ? "danger-button" : "configuration-primary-action"} disabled={busy} onClick={onConfirm}>
            {busy
              ? "处理中…"
              : deleting && preview.tasks.length > 0
                ? "删除会话并停用任务"
                : restoring
                  ? "恢复全部会话"
                  : `${verb}会话`}
          </button>
        </footer>
      </section>
    </div>
  );
}
