import { useId, type ReactNode } from "react";
import { Tabs } from "../ui/tabs";

interface QuestionStepTabsProps {
  count: number;
  activeIndex: number;
  onChange: (index: number) => void;
  label: string;
  children: ReactNode;
}

/** 历史问答共享页签键盘操作，当前问题和回答共用一个内容面板。 */
export function QuestionStepTabs({ count, activeIndex, onChange, label, children }: QuestionStepTabsProps) {
  const panelId = useId();
  if (count <= 1) return <>{children}</>;
  const value = String(activeIndex);
  return <>
    <Tabs
      className="question-step-tabs"
      label={label}
      panelId={panelId}
      value={value}
      onChange={(next) => onChange(Number(next))}
      items={Array.from({ length: count }, (_, index) => ({ id: String(index), label: String(index + 1) }))}
    />
    <div role="tabpanel" id={panelId} aria-labelledby={`${panelId}-${value}`}>{children}</div>
  </>;
}
