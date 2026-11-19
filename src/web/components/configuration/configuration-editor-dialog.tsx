import { X } from "lucide-react";
import { useEffect, useId, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import "../../configuration-editor-dialog.css";

/** 弹层共享滚动锁，防止同一次提交关闭抽屉和确认框后遗留 hidden。 */
let scrollLocks = 0;
let originalOverflow = "";

interface ConfigurationEditorDialogProps {
  /** 抽屉与删除确认共享焦点管理，但使用各自的页面样式。 */
  variant: "drawer" | "confirmation";
  /** 保留页面选择器和各自的可访问关闭名称，样式统一按弹层加载。 */
  closeLabel?: string;
  returnFocusSelector?: string;
  classPrefix?: string;
  className?: string;
  title: string;
  description: string;
  busy: boolean;
  suspended?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}

/** 管理配置编辑弹层的焦点、滚动与返回焦点，避免关闭确认和抽屉争抢键盘。 */
export function ConfigurationEditorDialog({ variant, title, description, busy, suspended = false, closeLabel = "关闭语音配置编辑", returnFocusSelector = "[data-tts-create]", classPrefix = "tts", className = "", onClose, children, footer }: ConfigurationEditorDialogProps) {
  const id = useId();
  const root = useRef<HTMLElement>(null);
  const latest = useRef({ busy, suspended, onClose });
  latest.current = { busy, suspended, onClose };
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    if (scrollLocks === 0) originalOverflow = document.body.style.overflow;
    scrollLocks += 1;
    document.body.style.overflow = "hidden";
    if (variant === "confirmation") root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    else root.current?.focus();
    function keydown(event: KeyboardEvent) {
      if (latest.current.suspended) return;
      if (event.key === "Escape") {
        event.preventDefault();
        if (!latest.current.busy) latest.current.onClose();
      }
      if (event.key !== "Tab") return;
      const controls = [...(root.current?.querySelectorAll<HTMLElement>("button, input, select, textarea, summary, a[href], video[controls], audio[controls], [tabindex]") ?? [])]
        .filter((element) => !element.matches(":disabled, [tabindex='-1']") && element.getClientRects().length > 0);
      const first = controls[0];
      const last = controls.at(-1);
      if (!first) { event.preventDefault(); root.current?.focus(); return; }
      if (event.shiftKey && (document.activeElement === first || document.activeElement === root.current || !root.current?.contains(document.activeElement))) {
        event.preventDefault(); last?.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === root.current || !root.current?.contains(document.activeElement))) {
        event.preventDefault(); first.focus();
      }
    }
    document.addEventListener("keydown", keydown);
    return () => {
      document.removeEventListener("keydown", keydown);
      scrollLocks -= 1;
      // 未保存保护也会恢复滚动；等所有弹层清理完成后再恢复最初的页面状态。
      const restoreOverflow = originalOverflow;
      if (scrollLocks === 0) document.body.style.overflow = restoreOverflow;
      window.queueMicrotask(() => {
        if (scrollLocks === 0 && !document.querySelector(".configuration-dialog-backdrop")) document.body.style.overflow = restoreOverflow;
      });
      // 保存或删除后原列表按钮可能已替换，返回当前配置页稳定的新建入口。
      if (previous?.isConnected) previous.focus();
      else document.querySelector<HTMLButtonElement>(returnFocusSelector)?.focus();
    };
  }, [variant, returnFocusSelector]);

  return createPortal(<div className={variant === "drawer" ? `configuration-editor-backdrop ${classPrefix}-drawer-backdrop` : "configuration-dialog-backdrop"}
    onMouseDown={(event) => { if (variant === "drawer" && event.target === event.currentTarget && !busy && !suspended) onClose(); }}>
    <section ref={root} tabIndex={-1} className={variant === "drawer" ? `configuration-editor-drawer ${classPrefix}-drawer` : ("configuration-dialog provider-rename-dialog " + className)}
      role="dialog" aria-modal={!suspended} aria-hidden={suspended || undefined} inert={suspended || undefined}
      aria-labelledby={id} aria-describedby={`${id}-description`} aria-busy={busy}>
      <header className={variant === "drawer" ? "configuration-editor-drawer__header" : undefined}><div><h2 id={id}>{title}</h2><p id={`${id}-description`}>{description}</p></div>
        {variant === "drawer" ? <button type="button" className="icon-button" aria-label={closeLabel} disabled={busy} onClick={onClose}><X size={19} /></button> : null}</header>
      <div className={variant === "drawer" ? "configuration-editor-drawer__content" : undefined}>{children}</div>
      <footer className={variant === "drawer" ? "configuration-editor-drawer__footer" : undefined}>{footer}</footer>
    </section>
  </div>, document.body);
}
