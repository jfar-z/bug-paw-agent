import type { ReactNode } from "react";
import { Dialog } from "../ui/dialog";

/** AIGC 接口与 MCP 授权共用宽抽屉，焦点和关闭行为由 Dialog 管理。 */
export function AigcConfigDrawer({ title, description, busy = false, onClose, children, footer }: {
  title: string;
  description: string;
  busy?: boolean;
  onClose: () => void;
  children: ReactNode;
  footer: ReactNode;
}) {
  return (
    <Dialog
      drawer="right"
      className="aigc-config-drawer"
      title={title}
      description={description}
      closeLabel="关闭编辑"
      busy={busy}
      onClose={onClose}
      onEscape={onClose}
      footer={footer}
    >
      {children}
    </Dialog>
  );
}
