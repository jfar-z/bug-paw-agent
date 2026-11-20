import { CheckCircle2, ChevronDown, ChevronRight, CircleAlert, CircleSlash2, Eye, LoaderCircle, TerminalSquare } from "lucide-react";
import { useState, type CSSProperties } from "react";
import { formatToolValue, type ToolBlock } from "../conversation-timeline";
import { toolActivityCopy, toolStatusCopy, toolTargetPath } from "../features/chat/tool-activity-copy";
import { dataFileLinkMediaKind } from "../workspace-links";
import { activityStatusStyle } from "./activity-status-style";
import { Collapse } from "../ui/collapse";

interface LiveToolCardProps {
  tool: ToolBlock;
  onLinkActivate?(href: string): boolean;
}

/**
 * 在活动轨迹中展示可折叠的工具入参、实时输出和最终结果。
 */
export function LiveToolCard({ tool, onLinkActivate }: LiveToolCardProps) {
  const [expanded, setExpanded] = useState(false);
  const output = tool.status === "running" ? tool.partialResult : tool.result;
  const previewPath = readToolPreviewPath(tool);
  const active = tool.status === "preparing" || tool.status === "parameterizing" || tool.status === "running";
  const statusIcon = active
    ? <LoaderCircle className="spinner" size={14} aria-hidden="true" />
    : tool.status === "error"
      ? <CircleAlert size={14} aria-hidden="true" />
      : tool.status === "cancelled"
        ? <CircleSlash2 size={14} aria-hidden="true" />
        : <CheckCircle2 size={14} aria-hidden="true" />;

  return (
    <section className={`live-tool-card is-${tool.status}`}>
      <div style={styles.header}>
        <button
          type="button"
          className="live-tool-card__summary"
          aria-expanded={expanded}
          aria-label={`${expanded ? "收起" : "展开"} ${tool.name} 工具详情`}
          onClick={() => setExpanded((current) => !current)}
        >
          {expanded ? <ChevronDown size={16} aria-hidden="true" /> : <ChevronRight size={16} aria-hidden="true" />}
          <TerminalSquare size={17} aria-hidden="true" />
          <strong className="activity-item__action">{toolActivityCopy(tool)}</strong>
        </button>
        <div className="live-tool-card__controls" style={styles.controls}>
          {previewPath && onLinkActivate ? <button
            type="button"
            className="icon-button"
            style={styles.previewButton}
            aria-label={`查看 ${previewPath} 文件内容`}
            title="查看文件内容"
            onClick={(event) => {
              event.currentTarget.focus({ preventScroll: true });
              onLinkActivate(previewPath);
            }}
          >
            <Eye size={15} aria-hidden="true" />
          </button> : null}
          <span
            className="live-tool-card__status"
            style={activityStatusStyle}
          >
            {statusIcon}<span>{toolStatusCopy(tool)}</span>
          </span>
        </div>
      </div>

      <Collapse expanded={expanded} className="live-tool-card__collapse">
        <div className="live-tool-card__details">
          {tool.status === "parameterizing"
            ? <ToolParameterProgress tool={tool} />
            : <>
              <ToolDetail title="入参" value={tool.args} />
              <ToolDetail title="结果" value={output} />
            </>}
          {hasToolDetailValue(tool.details) && <ToolDetail title="详情" value={tool.details} />}
        </div>
      </Collapse>
    </section>
  );
}

/** 仅允许已完成的 read 工具复用 Markdown 文件链接支持的预览范围。 */
export function readToolPreviewPath(tool: ToolBlock): string | undefined {
  if (tool.name !== "read" || tool.status !== "completed") return undefined;
  const path = toolTargetPath(tool.args);
  return path && dataFileLinkMediaKind(path) ? path : undefined;
}

const styles: Record<string, CSSProperties> = {
  header: { display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", alignItems: "start", gap: 2 },
  controls: { display: "inline-flex", minHeight: 28, alignItems: "center", gap: 2 },
  previewButton: { display: "inline-grid", width: 28, height: 28, placeItems: "center", padding: 0, border: 0, borderRadius: 7, color: "var(--text-tertiary)", background: "transparent" },
};

/** 展示不含原始参数的生成进度，避免大内容撑开工具详情。 */
function ToolParameterProgress({ tool }: { tool: ToolBlock }) {
  const bytes = tool.parameterBytes ?? 0;
  const path = tool.parameterPath;

  return (
    <section className="live-tool-card__detail">
      <h4 style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 600 }}>参数生成</h4>
      <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5 }}>参数生成中 · 已生成 {formatGeneratedBytes(bytes)}</p>
      {path && <p style={{ margin: "4px 0 0", fontSize: 12, lineHeight: 1.5, overflowWrap: "anywhere" }}>目标：{path}</p>}
    </section>
  );
}

/** 将累计参数字节数格式化为便于快速扫读的单位。 */
function formatGeneratedBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  return `${Number(kilobytes.toFixed(kilobytes < 10 ? 1 : 0))} KB`;
}

/** 判断可选详情是否包含值得展示的信息。 */
export function hasToolDetailValue(value: unknown): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function ToolDetail({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="live-tool-card__detail">
      <h4 style={{ margin: "0 0 6px", fontSize: 10, fontWeight: 600 }}>{title}</h4>
      <pre><code>{formatToolValue(value)}</code></pre>
    </section>
  );
}
