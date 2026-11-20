import { type ReactNode } from "react";
import "./ui.css";
/** 条目内容由调用方提供，主入口和行内操作分别获取焦点。 */
export function ConversationRow({
  title,
  summary,
  avatar,
  attachments,
  actions,
  active,
  onOpen,
}: {
  title: string;
  summary: ReactNode;
  avatar?: ReactNode;
  attachments?: ReactNode;
  actions?: ReactNode;
  active?: boolean;
  onOpen: () => void;
}) {
  return (
    <div className="bp-conversation">
      <button
        className="bp-conversation__open"
        type="button"
        aria-current={active ? "true" : undefined}
        onClick={onOpen}
      >
        {avatar}
        <span>
          <strong>{title}</strong>
          <small>{summary}</small>
        </span>
      </button>
      {actions && <div className="bp-actions">{actions}</div>}
      {attachments && <div className="bp-attachments">{attachments}</div>}
    </div>
  );
}
