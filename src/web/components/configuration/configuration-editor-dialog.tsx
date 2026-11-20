import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "../../ui/dialog-surface";
import "../../configuration-editor-dialog.css";

interface ConfigurationEditorDialogProps {
  /** 表单可放在宽抽屉或居中弹层内。 */
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

/** 复用原生模态层，保留配置编辑器的尺寸、草稿保护和关闭入口。 */
export function ConfigurationEditorDialog({
  variant, title, description, busy, suspended = false, closeLabel = "关闭编辑",
  returnFocusSelector, classPrefix, className = "", onClose, children, footer,
}: ConfigurationEditorDialogProps) {
  const drawer = variant === "drawer";
  return createPortal(
    <Dialog
      title={title}
      description={description}
      drawer={drawer ? "right" : false}
      className={drawer ? ["configuration-editor-drawer", classPrefix && `${classPrefix}-drawer`, className].filter(Boolean).join(" ")
        : `configuration-dialog provider-rename-dialog ${className}`}
      busy={busy}
      suspended={suspended}
      closeLabel={closeLabel}
      onClose={drawer ? onClose : undefined}
      onEscape={onClose}
      dismissOnBackdrop={drawer}
      returnFocusSelector={returnFocusSelector}
      footer={footer}
    >
      {children}
    </Dialog>,
    document.body,
  );
}
