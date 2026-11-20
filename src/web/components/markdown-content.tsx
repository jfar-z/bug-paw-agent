import { isValidElement, memo, useMemo, type ReactElement, type ReactNode } from "react";
import { FileText, FileType2, Image, Music2, Video } from "lucide-react";
import type { Element, Root, RootContent, Text } from "hast";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeKatex from "rehype-katex";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import "katex/dist/katex.min.css";
import "../markdown-content.css";
import { normalizeMathDelimiters } from "../markdown-math";
import type { ThemePreference } from "../theme";
import { useStreamingTextReveal } from "../use-streaming-text-reveal";
import { HighlightedCodeBlock } from "./highlighted-code-block";
import { MermaidDiagram } from "./mermaid-diagram";
import { dataFileLinkMediaKind, type DataFileLinkMediaKind } from "../workspace-links";

interface MarkdownContentProps {
  text: string;
  sessionEntryId?: string;
  focused?: boolean;
  streaming?: boolean;
  revealStart?: number;
  revealPhase?: number;
  theme?: ThemePreference;
  onLinkActivate?: (href: string) => boolean;
}

/**
 * 渲染安全的 GFM Markdown；不启用原始 HTML 解析。
 */
export const MarkdownContent = memo(function MarkdownContent({
  text,
  sessionEntryId,
  focused = false,
  streaming = false,
  revealStart,
  revealPhase = 0,
  theme = "bug",
  onLinkActivate,
}: MarkdownContentProps) {
  const { visibleText, isRevealing } = useStreamingTextReveal(text, streaming);
  const normalizedText = normalizeMathDelimiters(visibleText);
  const normalizedRevealStart = revealStart === undefined
    ? normalizedText.length
    : normalizeMathDelimiters(visibleText.slice(0, revealStart)).length;
  const components = useMemo<Components>(() => ({
    a: ({ href, children }) => {
      const external = href?.startsWith("http://") || href?.startsWith("https://");
      const mediaKind = href && onLinkActivate ? dataFileLinkMediaKind(href) : undefined;
      return (
        <a className={mediaKind ? "markdown-file-link" : undefined} href={href} {...(external ? { target: "_blank", rel: "noreferrer noopener" } : {})} onClick={(event) => {
          if (href && onLinkActivate?.(href)) {
            event.preventDefault();
            // 让文件预览关闭时回到触控或键盘激活的同一个链接。
            event.currentTarget.focus({ preventScroll: true });
          }
        }}>
          {children}
          {mediaKind ? <MarkdownFileIcon kind={mediaKind} /> : null}
        </a>
      );
    },
    pre: ({ children }) => {
      const codeElement = readCodeElement(children);
      if (!codeElement) {
        return <pre>{children}</pre>;
      }
      const language = /language-([^\s]+)/.exec(codeElement.className ?? "")?.[1];
      const code = String(codeElement.children).replace(/\n$/, "");
      const isMermaid = language?.toLowerCase() === "mermaid";
      if (isMermaid && !streaming) {
        return <MermaidDiagram code={code} theme={theme} />;
      }
      return <HighlightedCodeBlock code={code} language={language} wrapLines={!isMermaid} />;
    },
  }), [onLinkActivate, streaming, theme]);

  return (
    <div
      className={`markdown-content${isRevealing ? " is-text-revealing" : ""}${focused ? " is-session-search-focus" : ""}`}
      data-session-entry-id={sessionEntryId}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[
          rehypeKatex,
          ...(isRevealing && normalizedRevealStart < normalizedText.length
            ? [[
              rehypeStreamingTail,
              { startOffset: normalizedRevealStart, phase: revealPhase },
            ] as [typeof rehypeStreamingTail, StreamingTailOptions]]
            : []),
        ]}
        components={components}
      >
        {normalizedText}
      </ReactMarkdown>
    </div>
  );
});

/** 在链接文字后追加不改变行高的文件类型图标。 */
function MarkdownFileIcon({ kind }: { kind: DataFileLinkMediaKind }) {
  const Icon = kind === "image" ? Image
    : kind === "video" ? Video
    : kind === "audio" ? Music2
    : kind === "pdf" ? FileType2
    : FileText;
  return <Icon className="markdown-file-link__icon" size={14} aria-hidden="true" style={{ display: "inline-block", marginLeft: 4, verticalAlign: -2 }} />;
}

interface CodeElementProps {
  className?: string;
  children?: ReactNode;
}

function readCodeElement(children: ReactNode): CodeElementProps | undefined {
  if (!isValidElement(children) || children.type !== "code") {
    return undefined;
  }
  return (children as ReactElement<CodeElementProps>).props;
}

interface StreamingTailOptions {
  startOffset: number;
  phase: number;
}

/**
 * 仅包装 Markdown AST 中属于最新 SSE 增量的文本节点。
 */
function rehypeStreamingTail(options: StreamingTailOptions) {
  return (tree: Root) => wrapStreamingTail(tree, options);
}

/**
 * 递归切分文本节点；代码块保持原始结构，避免破坏高亮和复制逻辑。
 */
function wrapStreamingTail(parent: Root | Element, options: StreamingTailOptions): void {
  for (let index = 0; index < parent.children.length; index += 1) {
    const child = parent.children[index];
    if (child.type === "element") {
      if (!SKIPPED_TAIL_TAGS.has(child.tagName)) {
        wrapStreamingTail(child, options);
      }
      continue;
    }
    if (child.type !== "text") {
      continue;
    }
    const startOffset = child.position?.start.offset;
    const endOffset = child.position?.end.offset;
    if (startOffset === undefined || endOffset === undefined || endOffset <= options.startOffset) {
      continue;
    }
    const splitAt = Math.max(0, Math.min(child.value.length, options.startOffset - startOffset));
    if (splitAt >= child.value.length) {
      continue;
    }
    const replacement: RootContent[] = [];
    if (splitAt > 0) {
      replacement.push({ ...child, value: child.value.slice(0, splitAt) } as Text);
    }
    replacement.push({
      type: "element",
      tagName: "span",
      properties: { className: ["streaming-text-tail", `streaming-text-tail--${options.phase % 2}`] },
      children: [{ ...child, value: child.value.slice(splitAt) } as Text],
    });
    parent.children.splice(index, 1, ...replacement);
    index += replacement.length - 1;
  }
}

const SKIPPED_TAIL_TAGS = new Set(["code", "pre", "script", "style"]);
