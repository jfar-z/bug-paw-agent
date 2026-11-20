import { Button, IconButton } from "../ui/controls";
import { ArchiveRestore, Trash2, X } from "lucide-react";
import { useState } from "react";
import type { SessionSummary } from "../api";

interface ArchivedSessionsDialogProps {
  open: boolean;
  sessions: SessionSummary[];
  busy: boolean;
  onClose: () => void;
  onOpen: (sessionId: string) => void | Promise<void>;
  onRestore: (sessionId: string) => void | Promise<void>;
  onDelete: (sessionId: string) => void | Promise<void>;
  onRestoreAll: () => void;
  onDeleteAll: () => void;
}

/**
 * 集中展示归档会话，并提供恢复和永久删除入口。
 */
export function ArchivedSessionsDialog({
  open,
  sessions,
  busy,
  onClose,
  onOpen,
  onRestore,
  onDelete,
  onRestoreAll,
  onDeleteAll,
}: ArchivedSessionsDialogProps) {
  const [confirmingId, setConfirmingId] = useState<string>();
  if (!open) {
    return null;
  }

  return (
    <div className="archive-dialog__backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) {
        onClose();
      }
    }}>
      <section className="archive-dialog" role="dialog" aria-modal="true" aria-labelledby="archive-dialog-title">
        <header>
          <div><span>会话管理</span><h2 id="archive-dialog-title">已归档会话</h2></div>
          <IconButton label="关闭已归档会话" onClick={onClose}><X size={18} /></IconButton>
        </header>
        <div
          className="configuration-heading-actions archive-dialog__bulk-bar"
          style={{ flexWrap: "wrap", padding: "10px 16px", borderBottom: "1px solid var(--border)", background: "var(--panel)" }}
        >
          <span style={{ color: "var(--text-tertiary)", fontSize: 11 }}>共 {sessions.length} 个会话</span>
          <div className="configuration-heading-actions" style={{ gap: 8 }}>
            <Button type="button" className="configuration-secondary-action" style={{ minHeight: 44 }} disabled={busy || sessions.length === 0} onClick={onRestoreAll}>
              <ArchiveRestore size={16} aria-hidden="true" />
              全部恢复
            </Button>
            <Button variant="danger" type="button" className="configuration-secondary-action configuration-secondary-action--danger" style={{ minHeight: 44 }} disabled={busy || sessions.length === 0} onClick={onDeleteAll}>
              <Trash2 size={16} aria-hidden="true" />
              全部删除
            </Button>
          </div>
        </div>
        <div className="archive-dialog__list">
          {sessions.length === 0 && <p className="archive-dialog__empty">还没有归档会话。</p>}
          {sessions.map((session) => {
            const title = session.name || session.firstMessage || "新对话";
            return (
              <article className="archive-dialog__row" key={session.id}>
                <button type="button" className="archive-dialog__open" aria-label={`打开${title}`} disabled={busy} onClick={() => void onOpen(session.id)}>
                  <strong>{title}</strong>
                  <span>{session.messageCount} 条消息</span>
                </button>
                {confirmingId === session.id ? (
                  <div className="archive-dialog__confirm">
                    <Button size="sm" disabled={busy} onClick={() => setConfirmingId(undefined)}>取消</Button>
                    <Button variant="danger" size="sm" disabled={busy} onClick={() => { void onDelete(session.id); setConfirmingId(undefined); }}>确认永久删除</Button>
                  </div>
                ) : (
                  <div className="archive-dialog__actions">
                    <IconButton size="sm" label={`恢复${title}`} disabled={busy} onClick={() => void onRestore(session.id)}><ArchiveRestore size={16} /></IconButton>
                    <IconButton size="sm" danger label={`删除${title}`} disabled={busy} onClick={() => setConfirmingId(session.id)}><Trash2 size={16} /></IconButton>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </div>
  );
}
