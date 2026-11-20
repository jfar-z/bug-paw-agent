import { Archive, ListChecks, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useId, useState } from "react";
import type { SessionSummary } from "../api";
import { Button, TextField } from "../ui/controls";
import { ConfirmDialog, Dialog } from "../ui/dialog";
import { Menu } from "../ui/menu";

interface SessionActionsMenuProps {
  session: SessionSummary;
  disabled?: boolean;
  openRequestId?: number;
  onPinChange: (pinned: boolean) => Promise<boolean>;
  onRename: (name: string) => void | Promise<void>;
  onArchive: () => void | Promise<void>;
  onDelete: (confirmBoundTasks: boolean) => void | Promise<void>;
  onSelectMultiple?: () => void;
}

/** 会话快捷操作由菜单发起，编辑和危险确认使用各自的公共弹层。 */
export function SessionActionsMenu({ session, disabled, openRequestId, onPinChange, onRename, onArchive, onDelete, onSelectMultiple }: SessionActionsMenuProps) {
  const [pinning, setPinning] = useState(false);
  const [action, setAction] = useState<"rename" | "delete">();
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const formId = useId();
  const title = session.name || session.firstMessage || "新对话";
  const closeAction = () => setAction(undefined);

  return <>
    <Menu portal className="session-actions" triggerClassName="session-actions__trigger" triggerVariant="ghost"
      label={`管理会话：${title}`} icon={<MoreHorizontal size={16} />} openRequestId={openRequestId}
      items={[
        { key: "rename", label: "重命名", icon: <Pencil />, onSelect: () => { setName(title); setAction("rename"); } },
        { key: "pin", label: session.pinned ? "取消置顶" : "置顶", icon: session.pinned ? <PinOff /> : <Pin />,
          keepOpen: true, disabled: pinning, onSelect: async (close) => {
            if (pinning) return;
            setPinning(true);
            try {
              if (await onPinChange(!session.pinned)) close();
            } finally {
              setPinning(false);
            }
          } },
        ...(onSelectMultiple ? [{ key: "multi", label: "多选", icon: <ListChecks />, onSelect: onSelectMultiple }] : []),
        { key: "archive", label: "归档", icon: <Archive />, disabled, onSelect: () => void onArchive() },
        { key: "delete", label: "删除", icon: <Trash2 />, danger: true, disabled, onSelect: () => setAction("delete") },
      ]} />
    {action === "rename" && <Dialog title="重命名会话" onClose={closeAction} footer={<>
      <Button onClick={closeAction}>取消</Button>
      <Button variant="primary" type="submit" form={formId} disabled={!name.trim()}>保存名称</Button>
    </>}>
      <form id={formId} onSubmit={(event) => {
        event.preventDefault();
        const nextName = name.trim();
        if (!nextName) return;
        void onRename(nextName);
        closeAction();
      }}>
        <label className="bp-field">会话名称
          <TextField data-initial-focus aria-label="重命名会话" value={name} maxLength={100} onChange={(event) => setName(event.target.value)} />
        </label>
      </form>
    </Dialog>}
    {action === "delete" && <ConfirmDialog title="永久删除会话" confirmLabel="永久删除" busy={busy}
      description={session.scheduledTaskCount
        ? `绑定的 ${session.scheduledTaskCount} 个定时任务将同步停用，任务记录会保留。`
        : `将永久删除「${title}」。`}
      onCancel={closeAction} onConfirm={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await onDelete(Boolean(session.scheduledTaskCount));
          closeAction();
        } finally {
          setBusy(false);
        }
      }} />}
  </>;
}
