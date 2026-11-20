import { Button, IconButton } from "../ui/controls";
import { ConfirmDialog, Dialog } from "../ui/dialog";
import { ArchiveRestore, Trash2 } from "lucide-react";
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
  if (!open) {
    return null;
  }

  return <ArchivedSessionsContent sessions={sessions} busy={busy}
    onClose={onClose} onOpen={onOpen} onRestore={onRestore} onDelete={onDelete}
    onRestoreAll={onRestoreAll} onDeleteAll={onDeleteAll} />;
}

/** 关闭归档列表时一并清理单条删除确认。 */
function ArchivedSessionsContent({ sessions, busy, onClose, onOpen, onRestore, onDelete, onRestoreAll, onDeleteAll }: Omit<ArchivedSessionsDialogProps, "open">) {
  const [confirming, setConfirming] = useState<SessionSummary>();
  const [deleting, setDeleting] = useState(false);
  return (<>
    <Dialog title="已归档会话" closeLabel="关闭已归档会话" onClose={onClose} busy={busy} className="archive-dialog">
      <div className="configuration-heading-actions archive-dialog__bulk-bar">
        <small>共 {sessions.length} 个会话</small>
        <div className="configuration-heading-actions">
          <Button disabled={busy || sessions.length === 0} onClick={onRestoreAll} icon={<ArchiveRestore aria-hidden />}>全部恢复</Button>
          <Button variant="danger" disabled={busy || sessions.length === 0} onClick={onDeleteAll} icon={<Trash2 aria-hidden />}>全部删除</Button>
        </div>
      </div>
      <div className="archive-dialog__list">
        {sessions.length === 0 && <p className="archive-dialog__empty">还没有归档会话。</p>}
        {sessions.map((session) => {
          const title = session.name || session.firstMessage || "新对话";
          return (
            <article className="archive-dialog__row" key={session.id}>
              <Button variant="ghost" className="archive-dialog__open" aria-label={`打开${title}`} disabled={busy} onClick={() => void onOpen(session.id)}>
                <strong>{title}</strong>
                <span>{session.messageCount} 条消息</span>
              </Button>
              <div className="archive-dialog__actions">
                <IconButton size="sm" label={`恢复${title}`} disabled={busy} onClick={() => void onRestore(session.id)}><ArchiveRestore size={16} /></IconButton>
                <IconButton size="sm" danger label={`删除${title}`} disabled={busy} onClick={() => setConfirming(session)}><Trash2 size={16} /></IconButton>
              </div>
            </article>
          );
        })}
      </div>
    </Dialog>
    {confirming && <ConfirmDialog title="永久删除归档会话" description={`将永久删除「${confirming.name || confirming.firstMessage || "新对话"}」。`}
      confirmLabel="确认永久删除" busy={deleting} onCancel={() => setConfirming(undefined)}
      onConfirm={async () => {
        if (deleting) return;
        setDeleting(true);
        try {
          await onDelete(confirming.id);
          setConfirming(undefined);
        } finally {
          setDeleting(false);
        }
      }} />}
  </>);
}
