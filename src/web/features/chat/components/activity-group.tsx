import type { ActivityBlock } from "../activity-groups";
import { toolActivityCopy } from "../tool-activity-copy";
import { LiveToolCard } from "../../../components/live-tool-card";
import { ThinkingCard } from "../../../components/thinking-card";
import { Collapse } from "../../../ui/collapse";

export interface ActivityGroupProps {
  id: string;
  blocks: ActivityBlock[];
  trailing: boolean;
  turnStreaming: boolean;
  expandedOverride?: boolean;
  onLinkActivate?(href: string): boolean;
  onExpandedChange(expanded: boolean): void;
}

/** 展示相邻思考与工具组成的活动段。 */
export function ActivityGroup({
  blocks,
  trailing,
  turnStreaming,
  expandedOverride,
  onLinkActivate,
  onExpandedChange,
}: ActivityGroupProps) {
  const summary = activityGroupSummary(blocks);
  const expanded = expandedOverride ?? activityGroupAutomaticExpanded(blocks, trailing, turnStreaming);

  return <section className={`activity-group${blocks.some(isFailedTool) ? " has-error" : ""}`}>
    <button
      type="button"
      className="activity-group__summary"
      aria-expanded={expanded}
      aria-label={`${expanded ? "收起" : "展开"}活动段：${summary}`}
      onClick={() => onExpandedChange(!expanded)}
    >
      <span className="activity-group__chevron" aria-hidden="true">{expanded ? "⌄" : "›"}</span>
      <strong>{summary}</strong>
      <span className="activity-group__meta">{activityGroupMeta(blocks)}</span>
    </button>
    <Collapse expanded={expanded} className="activity-group__collapse">
      <div className="activity-rail">
        {blocks.map((block) => block.type === "thinking"
          ? <ThinkingCard key={block.id} thinking={block} />
          : <LiveToolCard key={block.id} tool={block} onLinkActivate={onLinkActivate} />)}
      </div>
    </Collapse>
  </section>;
}

/** 判断未被用户覆盖时活动段是否自动展开。 */
export function activityGroupAutomaticExpanded(
  blocks: readonly ActivityBlock[],
  trailing: boolean,
  turnStreaming: boolean,
): boolean {
  return blocks.some(isFailedTool)
    || blocks.some((block) => block.type === "thinking"
      ? block.streaming
      : block.status === "preparing" || block.status === "parameterizing" || block.status === "running")
    || (trailing && turnStreaming);
}

function activityGroupSummary(blocks: readonly ActivityBlock[]): string {
  const failures = blocks.filter(isFailedTool).length;
  if (failures > 0) return `${blocks.length} 项活动 · ${failures} 项失败`;
  const active = [...blocks].reverse().find((block) => block.type === "thinking"
    ? block.streaming
    : block.status === "preparing" || block.status === "parameterizing" || block.status === "running");
  if (active?.type === "thinking") return "正在思考";
  if (active?.type === "tool") return toolActivityCopy(active);
  return `已完成 ${blocks.length} 项活动`;
}

function activityGroupMeta(blocks: readonly ActivityBlock[]): string {
  const thinkingCount = blocks.filter((block) => block.type === "thinking").length;
  const toolCount = blocks.length - thinkingCount;
  return [thinkingCount ? `思考 ${thinkingCount}` : "", toolCount ? `工具 ${toolCount}` : ""].filter(Boolean).join(" · ");
}

function isFailedTool(block: ActivityBlock): block is Extract<ActivityBlock, { type: "tool" }> {
  return block.type === "tool" && block.status === "error";
}
