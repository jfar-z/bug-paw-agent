import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { X } from "lucide-react";
import { Button, IconButton, TextField } from "./controls";
import "./dialog.css";

/** 父级控制挂载和关闭，原生模态层负责焦点范围及关闭后的恢复。 */
export function Dialog({
  title,
  children,
  footer,
  onClose,
  closeLabel = "关闭",
  busy = false,
  drawer = false,
  className = "",
  style,
  bodyStyle,
  dismissOnBackdrop = true,
}: {
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  onClose?: () => void;
  closeLabel?: string;
  busy?: boolean;
  drawer?: boolean | "left" | "right";
  className?: string;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  dismissOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  useViewportScrollLock();
  useLayoutEffect(() => {
    const node = ref.current!;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    node.showModal();
    node.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      node.close();
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <dialog
      className={["bp-dialog", drawer && "bp-dialog--drawer", className]
        .filter(Boolean)
        .join(" ")}
      data-side={drawer === "right" ? "right" : undefined}
      ref={ref}
      style={style}
      aria-modal="true"
      aria-busy={busy}
      aria-labelledby={id}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.key !== "Tab") return;
        const dialog = event.currentTarget;
        if (!(event.target instanceof Element) || event.target.closest("dialog") !== dialog) return;
        // 模态层屏蔽背景，首尾循环同时阻止焦点跳到浏览器地址栏。
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], summary, [tabindex], [contenteditable='true'], audio[controls], video[controls]",
        )).filter((node) =>
          node.tabIndex >= 0 && !node.matches(":disabled") &&
          node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible",
        );
        const first = controls[0], last = controls.at(-1);
        const current = document.activeElement;
        if (event.shiftKey ? current === first : current === last) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onCancel={(e) => {
        e.preventDefault();
        if (!busy) onClose?.();
      }}
      onClick={(e) => {
        if (!dismissOnBackdrop || e.target !== ref.current || busy) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          onClose?.();
      }}
    >
      <div className="bp-dialog__header">
        <h2 className="bp-dialog__title" id={id}>
          {title}
        </h2>
        {onClose && (
          <IconButton label={closeLabel} disabled={busy} onClick={onClose}>
            <X />
          </IconButton>
        )}
      </div>
      <div className="bp-dialog__body" style={bodyStyle}>{children}</div>
      {footer && <div className="bp-dialog__footer">{footer}</div>}
    </dialog>
  );
}

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
