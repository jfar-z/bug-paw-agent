import { Brain, CheckCircle2, ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useLayoutEffect, useRef, useState } from "react";
import type { ThinkingBlock } from "../conversation-timeline";
import { useStreamingTextReveal } from "../use-streaming-text-reveal";
import { activityStatusStyle } from "./activity-status-style";
import { Collapse } from "../ui/collapse";

interface ThinkingCardProps {
  thinking: ThinkingBlock;
}

/**
 * 在活动轨迹中展示模型思考摘要，详情由用户按需展开。
 */
export function ThinkingCard({ thinking }: ThinkingCardProps) {
  const [expanded, setExpanded] = useState(false);
  const contentRef = useRef<HTMLPreElement>(null);
  const { visibleText, isRevealing } = useStreamingTextReveal(thinking.text, thinking.streaming);
  const revealStart = Math.max(0, Math.min(thinking.revealStart ?? visibleText.length, visibleText.length));
  const stableText = visibleText.slice(0, revealStart);
  const revealText = visibleText.slice(revealStart);

  useLayoutEffect(() => {
    if (thinking.streaming && expanded && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [expanded, thinking.streaming, visibleText]);

  return (
    <section className={`thinking-card${thinking.streaming ? " is-streaming" : ""}`}>
      <button
        type="button"
        className="thinking-card__summary"
        aria-expanded={expanded}
        aria-label={`${expanded ? "收起" : "展开"}思考详情`}
        onClick={() => setExpanded((current) => !current)}
      >
        {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
        <Brain size={17} aria-hidden="true" />
        <strong className="activity-item__action">{thinking.streaming ? "正在思考" : "思考过程"}</strong>
        <span
          className="thinking-card__status"
          style={activityStatusStyle}
        >
          {thinking.streaming
            ? <LoaderCircle className="spinner" size={14} aria-hidden="true" />
            : <CheckCircle2 size={14} aria-hidden="true" />}
          <span>{thinking.streaming ? "思考中" : "已完成"}</span>
        </span>
      </button>
      <Collapse expanded={expanded} className="thinking-card__collapse">
        <pre ref={contentRef} className={`thinking-card__content${isRevealing ? " is-text-revealing" : ""}`}>
          {stableText}
          {isRevealing && revealText ? (
            <span className={`streaming-text-tail streaming-text-tail--${(thinking.revealPhase ?? 0) % 2}`}>
              {revealText}
            </span>
          ) : revealText}
        </pre>
      </Collapse>
    </section>
  );
}
