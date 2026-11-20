import {
  useId,
  useLayoutEffect,
  useRef,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useErrorToastModal } from "../error-toast-provider";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { X } from "lucide-react";
import { IconButton } from "./controls";

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
  suspended = false,
  returnFocusSelector,
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
  suspended?: boolean;
  returnFocusSelector?: string;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    id = useId();
  const lastDialogFocus = useRef<HTMLElement>(null);
  const toastRegion = useRef<HTMLDivElement>(null);
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
      const restore = () => {
        const target = previous?.isConnected ? previous
          : returnFocusSelector ? document.querySelector<HTMLElement>(returnFocusSelector) : null;
        target?.focus();
      };
      // 同时卸载抽屉和确认框时，等最上层退出后再尝试恢复页面入口。
      if (previous?.isConnected) restore();
      if (document.activeElement !== previous) {
        queueMicrotask(() => {
          if (document.activeElement === document.body) restore();
        });
      }
    };
  }, [interactive, registerToastModal, returnFocusSelector]);

  function restoreAfterToast() {
    // 关闭通知时，优先回到用户刚操作的表单字段或按钮。
    lastDialogFocus.current?.focus();
    const active = document.activeElement;
    if (ref.current?.contains(active) && !toastRegion.current?.contains(active)) return;
    ref.current?.querySelector<HTMLElement>(".bp-dialog__header button:not(:disabled)")?.focus();
    if (toastRegion.current?.contains(document.activeElement)) ref.current?.focus();
  }
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
      aria-modal={(interactive && !suspended) || undefined}
      aria-hidden={suspended || undefined}
      aria-busy={busy}
      aria-labelledby={id}
      aria-describedby={description ? `${id}-description` : undefined}
      onFocusCapture={(event) => {
        if (event.currentTarget.contains(event.target) && !toastRegion.current?.contains(event.target)) {
          lastDialogFocus.current = event.target;
        }
      }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || suspended) return;
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
        if (!busy && !suspended) (onEscape ?? onClose)?.();
      }}
      onClick={(e) => {
        if (!dismissOnBackdrop || e.target !== ref.current || busy || suspended) return;
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
      <header className="bp-dialog__header">
        {description ? (
          <div>
            <h2 className="bp-dialog__title" id={id}>{title}</h2>
            <p className="bp-dialog__description" id={`${id}-description`}>{description}</p>
          </div>
        ) : <h2 className="bp-dialog__title" id={id}>{title}</h2>}
        {hasHeaderActions ? <div className="bp-dialog__actions">{headerActions}{closeButton}</div> : closeButton}
      </header>
      {toastModal?.activeModal === ref.current && !suspended && (
        <div ref={toastRegion} className="bp-dialog__notifications">
          {toastModal?.renderToast(restoreAfterToast)}
        </div>
      )}
      <div className="bp-dialog__body" style={bodyStyle}>{children}</div>
      {footer && <footer className="bp-dialog__footer">{footer}</footer>}
    </dialog>
  );
}
