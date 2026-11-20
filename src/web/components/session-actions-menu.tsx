import { TextField } from "../ui/controls";
import { Archive, ListChecks, MoreHorizontal, Pencil, Pin, PinOff, Trash2 } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { SessionSummary } from "../api";

const MENU_VIEWPORT_MARGIN = 8;
const MENU_TRIGGER_GAP = 4;

interface MenuPosition {
  top: number;
  left: number;
}

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

/**
 * 提供单个会话的轻量操作菜单和危险操作确认。
 */
export function SessionActionsMenu({ session, disabled, openRequestId, onPinChange, onRename, onArchive, onDelete, onSelectMultiple }: SessionActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [pinning, setPinning] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [name, setName] = useState(session.name || session.firstMessage || "新对话");
  const [menuPosition, setMenuPosition] = useState<MenuPosition>();
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const handledOpenRequestRef = useRef(openRequestId);
  const title = session.name || session.firstMessage || "新对话";

  /** 将浮层约束在视口内，避免受到会话滚动容器的边界裁切。 */
  const updatePosition = useCallback(() => {
    const trigger = triggerRef.current;
    const menu = menuRef.current;
    if (!trigger || !menu) {
      return;
    }

    const triggerRect = trigger.getBoundingClientRect();
    const menuRect = menu.getBoundingClientRect();
    const below = triggerRect.bottom + MENU_TRIGGER_GAP;
    const above = triggerRect.top - MENU_TRIGGER_GAP - menuRect.height;
    const top = below + menuRect.height <= window.innerHeight - MENU_VIEWPORT_MARGIN
      ? below
      : Math.max(MENU_VIEWPORT_MARGIN, above);
    const left = Math.min(
      Math.max(MENU_VIEWPORT_MARGIN, triggerRect.right - menuRect.width),
      Math.max(MENU_VIEWPORT_MARGIN, window.innerWidth - MENU_VIEWPORT_MARGIN - menuRect.width),
    );
    setMenuPosition({ top, left });
  }, []);

  useEffect(() => {
    if (!open) {
      return;
    }
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !menuRef.current?.contains(target)) {
        setOpen(false);
        setRenaming(false);
        setConfirmingDelete(false);
      }
    };
    document.addEventListener("pointerdown", closeOutside);
    return () => document.removeEventListener("pointerdown", closeOutside);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [confirmingDelete, open, renaming, updatePosition]);

  useEffect(() => {
    if (openRequestId === undefined || openRequestId === handledOpenRequestRef.current) {
      return;
    }
    handledOpenRequestRef.current = openRequestId;
    setOpen(true);
    setRenaming(false);
    setConfirmingDelete(false);
  }, [openRequestId]);

  const submitRename = () => {
    const nextName = name.trim();
    if (!nextName) {
      return;
    }
    void onRename(nextName);
    setRenaming(false);
    setOpen(false);
  };

  /** 等待置顶状态持久化成功后再关闭菜单，失败时保留原状态供用户重试。 */
  const changePinned = async () => {
    if (pinning) return;
    setPinning(true);
    try {
      if (await onPinChange(!session.pinned)) setOpen(false);
    } finally {
      setPinning(false);
    }
  };

  return (
    <div className="session-actions" ref={rootRef}>
      <button
        ref={triggerRef}
        type="button"
        className="session-actions__trigger"
        aria-label={`管理会话：${title}`}
        aria-expanded={open}
        onClick={() => {
          setOpen((current) => !current);
          setRenaming(false);
          setConfirmingDelete(false);
        }}
      >
        <MoreHorizontal size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div
          ref={menuRef}
          className="session-actions__popover"
          role="menu"
          style={menuPosition
            ? { top: menuPosition.top, left: menuPosition.left }
            : { top: 0, left: 0, visibility: "hidden" }}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setOpen(false);
            }
          }}
        >
          {renaming ? (
            <TextField
              autoFocus
              aria-label="重命名会话"
              value={name}
              maxLength={100}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  submitRename();
                }
                if (event.key === "Escape") {
                  setRenaming(false);
                }
              }}
            />
          ) : confirmingDelete ? (
            <div className="session-actions__confirm">
              <p className={session.scheduledTaskCount ? "session-actions__task-warning" : undefined} style={session.scheduledTaskCount ? { padding: 7, border: "1px solid var(--danger)", borderRadius: 7, color: "var(--danger)", background: "color-mix(in srgb, var(--danger) 9%, var(--surface))", fontWeight: 650 } : undefined}>{session.scheduledTaskCount
                ? `永久删除此会话？绑定的 ${session.scheduledTaskCount} 个定时任务将同步停用，任务记录会保留。`
                : "永久删除此会话？"}</p>
              <div>
                <button type="button" onClick={() => setConfirmingDelete(false)}>取消</button>
                <button type="button" className="is-danger" onClick={() => { void onDelete(Boolean(session.scheduledTaskCount)); setOpen(false); }}>永久删除</button>
              </div>
            </div>
          ) : (
            <>
              <button type="button" role="menuitem" onClick={() => setRenaming(true)}><Pencil size={15} />重命名</button>
              <button type="button" role="menuitem" disabled={pinning} onClick={() => void changePinned()}>
                {session.pinned ? <PinOff size={15} /> : <Pin size={15} />}
                {session.pinned ? "取消置顶" : "置顶"}
              </button>
              {onSelectMultiple ? <button type="button" role="menuitem" onClick={() => { onSelectMultiple(); setOpen(false); }}><ListChecks size={15} />多选</button> : null}
              <button type="button" role="menuitem" disabled={disabled} onClick={() => { void onArchive(); setOpen(false); }}><Archive size={15} />归档</button>
              <button type="button" role="menuitem" className="is-danger" disabled={disabled} onClick={() => setConfirmingDelete(true)}><Trash2 size={15} />删除</button>
            </>
          )}
        </div>,
        document.body,
      )}
    </div>
  );
}
