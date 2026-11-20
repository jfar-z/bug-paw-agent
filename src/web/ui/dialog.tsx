import {
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useErrorToastModal } from "../error-toast-provider";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { X } from "lucide-react";
import { Button, IconButton, TextField } from "./controls";
import "./dialog.css";

/** 父级控制挂载和关闭，原生模态层负责焦点范围及关闭后的恢复。 */
export function Dialog({
  title,
  description,
  children,
  footer,
  headerActions,
  onClose,
  onEscape,
  closeLabel = "关闭",
  busy = false,
  drawer = false,
  className = "",
  style,
  bodyStyle,
  dismissOnBackdrop = true,
  interactive = true,
}: {
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  headerActions?: ReactNode;
  onClose?: () => void;
  onEscape?: () => void;
  closeLabel?: string;
  busy?: boolean;
  drawer?: boolean | "left" | "right";
  className?: string;
  style?: CSSProperties;
  bodyStyle?: CSSProperties;
  dismissOnBackdrop?: boolean | "surface";
  interactive?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  const toastModal = useErrorToastModal();
  const registerToastModal = toastModal?.registerModal;
  const hasHeaderActions = headerActions !== undefined;
  const closeButton = onClose && (
    <IconButton label={closeLabel} data-initial-focus={hasHeaderActions ? true : undefined} disabled={busy} onClick={onClose}>
      <X />
    </IconButton>
  );
  useViewportScrollLock(interactive);
  useLayoutEffect(() => {
    if (!interactive) return;
    const node = ref.current!;
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    node.showModal();
    const unregisterToastModal = registerToastModal?.(node);
    node.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    return () => {
      unregisterToastModal?.();
      node.close();
      if (!previous?.isConnected) return;
      previous.focus();
      if (document.activeElement !== previous) {
        // 放弃修改会同时关闭两层模态，等上层退出后再尝试恢复入口。
        queueMicrotask(() => {
          if (previous.isConnected && document.activeElement === document.body) previous.focus();
        });
      }
    };
  }, [interactive, registerToastModal]);
  return (
    <dialog
      className={["bp-dialog", drawer && "bp-dialog--drawer", className]
        .filter(Boolean)
        .join(" ")}
      data-side={drawer === "right" ? "right" : undefined}
      ref={ref}
      style={style}
      open={interactive ? undefined : true}
      inert={!interactive || undefined}
      aria-modal={interactive || undefined}
      aria-busy={busy}
      aria-labelledby={id}
      aria-describedby={description ? `${id}-description` : undefined}
      onKeyDown={(event) => {
        if (event.defaultPrevented) return;
        const dialog = event.currentTarget;
        if (!(event.target instanceof Element) || event.target.closest("dialog") !== dialog) return;
        if (onEscape && event.key === "Escape" && !document.fullscreenElement) {
          // 有内部层级的抽屉直接消费按键，避免原生 cancel 再关闭外层。
          event.preventDefault();
          event.stopPropagation();
          if (!busy && !event.repeat) onEscape();
          return;
        }
        if (event.key !== "Tab") return;
        // 模态层屏蔽背景，首尾循环同时阻止焦点跳到浏览器地址栏。
        const controls = Array.from(dialog.querySelectorAll<HTMLElement>(
          "button, input, select, textarea, a[href], summary, iframe, [tabindex], [contenteditable='true'], audio[controls], video[controls]",
        )).filter((node) =>
          node.tabIndex >= 0 && !node.matches(":disabled") &&
          node.getClientRects().length > 0 && getComputedStyle(node).visibility === "visible",
        );
        const first = controls[0], last = controls.at(-1);
        const current = document.activeElement;
        if (current === dialog || (event.shiftKey ? current === first : current === last)) {
          event.preventDefault();
          (event.shiftKey ? last : first)?.focus();
        }
      }}
      onCancel={(e) => {
        if (e.defaultPrevented || e.target !== e.currentTarget) return;
        e.preventDefault();
        if (!busy) (onEscape ?? onClose)?.();
      }}
      onClick={(e) => {
        if (!dismissOnBackdrop || e.target !== ref.current || busy) return;
        const r = e.currentTarget.getBoundingClientRect();
        if (
          dismissOnBackdrop === "surface" ||
          e.clientX < r.left ||
          e.clientX > r.right ||
          e.clientY < r.top ||
          e.clientY > r.bottom
        )
          onClose?.();
      }}
    >
      <div className="bp-dialog__header">
        {description ? (
          <div>
            <h2 className="bp-dialog__title" id={id}>{title}</h2>
            <p className="bp-dialog__description" id={`${id}-description`}>{description}</p>
          </div>
        ) : <h2 className="bp-dialog__title" id={id}>{title}</h2>}
        {hasHeaderActions ? <div className="bp-dialog__actions">{headerActions}{closeButton}</div> : closeButton}
      </div>
      <div className="bp-dialog__body" style={bodyStyle}>{children}</div>
      {footer && <div className="bp-dialog__footer">{footer}</div>}
      {toastModal?.activeModal === ref.current ? toastModal?.toast : null}
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
