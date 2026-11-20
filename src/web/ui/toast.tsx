import { Check, ChevronDown, ChevronUp, CircleAlert, Copy, X } from "lucide-react";
import { useState, type FocusEvent } from "react";
import type { ErrorToastItem } from "../error-toast-types";

interface ToastProps {
  items: ErrorToastItem[];
  announcement?: { id: string; text: string };
  onDismiss: (id: string) => void;
  restoreFocus?: () => void;
  onExpandedChange: (id: string, expanded: boolean) => void;
  onPauseChange: (id: string, source: "hover" | "focus", paused: boolean) => void;
}

/** 渲染全局非阻塞错误卡片，不参与错误分类和队列决策。 */
export function Toast(props: ToastProps) {
  return (
    <div className="error-toast-layer">
      <div className="visually-hidden" role="alert">
        {props.announcement ? <span key={props.announcement.id}>{props.announcement.text}</span> : null}
      </div>
      <div className="error-toast-viewport" aria-label="意外错误通知">
        {props.items.map((item) => (
          <ErrorToastCard key={item.id} item={item} {...props} />
        ))}
      </div>
    </div>
  );
}

function ErrorToastCard({
  item,
  onDismiss,
  restoreFocus,
  onExpandedChange,
  onPauseChange,
}: Omit<ToastProps, "items" | "announcement"> & { item: ErrorToastItem }) {
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const detailsId = `error-toast-details-${item.id}`;
  const leaveFocus = (event: FocusEvent<HTMLElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) onPauseChange(item.id, "focus", false);
  };
  const copyRequestId = async () => {
    if (!item.requestId) return;
    try {
      await navigator.clipboard.writeText(item.requestId);
      setCopyState("copied");
    } catch {
      // 剪贴板不可用时保留原文，方便用户手动选择复制。
      setCopyState("failed");
    }
  };
  return (
    <section
      className={`error-toast${item.expanded ? " is-expanded" : ""}${item.paused ? " is-paused" : ""}`}
      role="group"
      aria-label={item.title}
      onMouseEnter={() => onPauseChange(item.id, "hover", true)}
      onMouseLeave={() => onPauseChange(item.id, "hover", false)}
      onFocusCapture={() => onPauseChange(item.id, "focus", true)}
      onBlurCapture={leaveFocus}
    >
      <div className="error-toast__body">
        <CircleAlert className="error-toast__icon" size={18} aria-hidden="true" />
        <div className="error-toast__content">
          <strong>{item.title}</strong>
          <p>{item.summary}</p>
          <button
            type="button"
            className="error-toast__details-toggle"
            aria-expanded={item.expanded}
            aria-controls={detailsId}
            aria-label={item.expanded ? "收起错误详情" : "查看错误详情"}
            onClick={() => onExpandedChange(item.id, !item.expanded)}
          >
            {item.expanded ? <ChevronUp size={14} aria-hidden="true" /> : <ChevronDown size={14} aria-hidden="true" />}
            {item.expanded ? "收起详情" : "查看详情"}
          </button>
        </div>
        <button type="button" className="error-toast__close" aria-label="关闭错误通知" onClick={() => {
          restoreFocus?.();
          onDismiss(item.id);
        }}>
          <X size={16} aria-hidden="true" />
        </button>
      </div>
      {item.expanded ? (
        <dl className="error-toast__details" id={detailsId}>
          <Detail label="操作" value={item.operation} />
          <Detail label="错误码" value={item.code} />
          <Detail label="HTTP 状态" value={item.status?.toString()} />
          {item.requestId ? <div><dt>请求标识</dt><dd className="error-toast__request-id"><code>{item.requestId}</code><button type="button" aria-label="复制请求标识" onClick={() => void copyRequestId()}>{copyState === "copied" ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copyState === "copied" ? "已复制" : "复制"}</button>{copyState === "failed" ? <small>复制失败，请手动选择请求标识</small> : null}</dd></div> : null}
          <Detail label="说明" value={item.safeDetail} />
        </dl>
      ) : null}
      <span
        className="error-toast__progress"
        data-testid="error-toast-progress"
        aria-hidden="true"
        style={{ animationDuration: `${item.durationMs}ms` }}
      />
    </section>
  );
}

function Detail({ label, value }: { label: string; value?: string }) {
  if (!value) return null;
  return <div><dt>{label}</dt><dd>{value}</dd></div>;
}
