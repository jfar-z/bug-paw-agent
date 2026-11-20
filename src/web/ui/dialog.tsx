import { useState, type ReactNode } from "react";
import { Button, TextField } from "./controls";
import { Dialog } from "./dialog-surface";
import "./dialog.css";

export { Dialog };

export function ConfirmDialog({
  title,
  children,
  confirmDisabled,
  confirmClassName,
  requireText,
  confirmLabel = "确认",
  description,
  destructive = true,
  onCancel,
  onConfirm,
  busy = false,
}: {
  title: string;
  children?: ReactNode;
  confirmDisabled?: boolean;
  confirmClassName?: string;
  requireText?: string;
  confirmLabel?: string;
  description?: ReactNode;
  destructive?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
  busy?: boolean;
}) {
  const [text, setText] = useState("");
  return (
    <Dialog
      title={title}
      onClose={onCancel}
      busy={busy}
      footer={
        <>
          <Button data-initial-focus disabled={busy} onClick={onCancel}>
            取消
          </Button>
          <Button
            variant={destructive ? "danger" : "primary"}
            loading={busy}
            aria-label={confirmLabel}
            className={confirmClassName}
            disabled={
              confirmDisabled || (!!requireText && text !== requireText)
            }
            onClick={onConfirm}
          >
            {busy ? "处理中…" : confirmLabel}
          </Button>
        </>
      }
    >
      {description && <p>{description}</p>}
      {children && (
        <div role="region" aria-label="操作影响清单" tabIndex={0}>
          {children}
        </div>
      )}
      {requireText && (
        <label className="bp-field">
          <span>输入「{requireText}」以确认</span>
          <TextField
            disabled={busy}
            onKeyDown={(event) => {
              if (
                event.key === "Enter" &&
                !busy &&
                !confirmDisabled &&
                text === requireText
              ) {
                event.preventDefault();
                onConfirm();
              }
            }}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
        </label>
      )}
    </Dialog>
  );
}
