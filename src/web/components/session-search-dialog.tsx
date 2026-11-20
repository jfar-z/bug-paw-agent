import { Button } from "../ui/controls";
import { Archive, LoaderCircle, Search, X } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

import type { SessionTextSearchHit } from "../../shared/session-text-search";
import { MOBILE_BACK_REQUEST_EVENT } from "../use-mobile-back-navigation";
import { useSessionSearch } from "../use-session-search";

interface SessionSearchDialogProps {
  open: boolean;
  agentId?: string;
  onClose(): void;
  onSelect(hit: SessionTextSearchHit): Promise<void>;
}

/** 搜索当前 Agent 普通与归档会话中的可见聊天文本。 */
export function SessionSearchDialog(props: SessionSearchDialogProps) {
  const search = useSessionSearch(props.agentId);
  const inputRef = useRef<HTMLInputElement>(null);
  const previousFocusRef = useRef<HTMLElement | undefined>(undefined);
  const [activeIndex, setActiveIndex] = useState(0);
  const [selecting, setSelecting] = useState(false);
  const [selectionError, setSelectionError] = useState<string>();

  useEffect(() => {
    if (props.open) {
      previousFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
      inputRef.current?.focus({ preventScroll: true });
      return;
    }
    previousFocusRef.current?.focus({ preventScroll: true });
    previousFocusRef.current = undefined;
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    const onMobileBackRequest = (event: Event) => {
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
    return () => window.removeEventListener(MOBILE_BACK_REQUEST_EVENT, onMobileBackRequest);
  }, [props.open, props.onClose]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, search.hits.length - 1)));
  }, [search.hits.length]);

  if (!props.open) return null;

  const close = () => {
    setSelectionError(undefined);
    search.reset();
    props.onClose();
  };
  const clearSearch = () => {
    setSelectionError(undefined);
    search.setQuery("");
    inputRef.current?.focus({ preventScroll: true });
  };
  const select = async (hit: SessionTextSearchHit) => {
    if (selecting) return;
    setSelecting(true);
    setSelectionError(undefined);
    try {
      await props.onSelect(hit);
      close();
    } catch (reason) {
      setSelectionError(reason instanceof Error ? reason.message : "搜索结果已过期，请重新搜索");
    } finally {
      setSelecting(false);
    }
  };
  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      return;
    }
    if (event.key === "ArrowDown" && search.hits.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current + 1) % search.hits.length);
      return;
    }
    if (event.key === "ArrowUp" && search.hits.length > 0) {
      event.preventDefault();
      setActiveIndex((current) => (current - 1 + search.hits.length) % search.hits.length);
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const active = search.hits[activeIndex];
      if (active) void select(active);
      else void search.searchNow();
    }
  };

  return createPortal(
    <div className="configuration-dialog-backdrop session-search-dialog__backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) close();
    }}>
      <section className="configuration-dialog session-search-dialog" role="dialog" aria-modal="true" aria-labelledby="session-search-dialog-title">
        <header>
          <div><span>SESSIONS · SEARCH</span><h2 id="session-search-dialog-title">搜索聊天记录</h2></div>
          <button type="button" className="icon-button" aria-label="关闭聊天记录搜索" onClick={close}><X size={18} aria-hidden="true" /></button>
        </header>
        <div className="session-search-dialog__field">
          <Search size={17} aria-hidden="true" />
          <input
            ref={inputRef}
            type="text"
            role="searchbox"
            enterKeyHint="search"
            aria-label="搜索聊天记录"
            aria-controls="session-search-results"
            autoComplete="off"
            value={search.query}
            disabled={!props.agentId}
            placeholder="输入聊天内容关键词"
            onChange={(event) => { setSelectionError(undefined); search.setQuery(event.target.value); }}
            onKeyDown={onInputKeyDown}
          />
          <span className="session-search-dialog__field-actions">
            {(search.state === "loading" || search.state === "loadingMore")
              ? <LoaderCircle className="is-spinning" size={16} aria-hidden="true" /> : null}
            {search.query ? <button
              type="button"
              className="icon-button session-search-dialog__clear"
              aria-label="清空聊天记录搜索"
              onMouseDown={(event) => event.preventDefault()}
              onClick={clearSearch}
            ><X size={16} aria-hidden="true" /></button> : null}
          </span>
        </div>
        <p
          className={`session-search-dialog__announcement${statusVisuallyHidden(search.state) ? " visually-hidden" : ""}`}
          role="status"
          aria-live="polite"
        >
          {statusText(search.state, search.hits.length)}
        </p>
        <div className="session-search-dialog__results">
          {search.state === "idle" ? <p className="session-search-dialog__empty">输入内容以搜索当前 Agent 的聊天记录。</p> : null}
          {search.state === "empty" ? <p className="session-search-dialog__empty">没有找到匹配的聊天记录</p> : null}
          {search.state === "error" ? <div className="session-search-dialog__error"><p>{search.error}</p><Button type="button" className="configuration-secondary-action" onClick={() => void search.searchNow()}>重试</Button></div> : null}
          {selectionError ? <div className="session-search-dialog__error" role="alert"><p>{selectionError}</p><Button type="button" className="configuration-secondary-action" onClick={() => void search.searchNow()}>重新搜索</Button></div> : null}
          {search.hits.length > 0 ? <div id="session-search-results" className="knowledge-base-search-results" role="listbox" aria-label="聊天记录搜索结果">
            {search.hits.map((hit, index) => <button
              type="button"
              role="option"
              aria-selected={index === activeIndex}
              className={`session-search-result${index === activeIndex ? " is-active" : ""}`}
              key={`${hit.sessionId}:${hit.entryId}`}
              disabled={selecting}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={() => void select(hit)}
            >
              <span className="session-search-result__heading"><strong>{hit.sessionName || hit.sessionFirstMessage || "新对话"}</strong><span>{hit.archived ? <><Archive size={12} aria-hidden="true" />已归档</> : null}</span></span>
              <span className="session-search-result__snippet">{highlightSnippet(hit.snippet, hit.matchRanges)}</span>
              <span className="session-search-result__meta"><span>{hit.role === "assistant" ? "Agent" : "用户"}</span><time dateTime={hit.timestamp}>{formatTimestamp(hit.timestamp)}</time></span>
            </button>)}
          </div> : null}
        </div>
        {search.state === "success" && search.canLoadMore ? <footer>
          <button type="button" className="configuration-secondary-action session-search-dialog__load-more" aria-label="加载更多搜索结果" disabled={selecting} onClick={() => void search.loadMore()}>加载更多</button>
        </footer> : null}
      </section>
    </div>,
    document.body,
  );
}

/** 只用 React 文本节点和 mark 渲染服务端返回的有界命中范围。 */
function highlightSnippet(snippet: string, ranges: Array<{ start: number; end: number }>): ReactNode[] {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  ranges.forEach(({ start, end }, index) => {
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < cursor || end <= start || end > snippet.length) return;
    if (start > cursor) nodes.push(snippet.slice(cursor, start));
    nodes.push(<mark key={`${start}:${end}:${index}`}>{snippet.slice(start, end)}</mark>);
    cursor = end;
  });
  if (cursor < snippet.length) nodes.push(snippet.slice(cursor));
  return nodes;
}

function statusText(state: ReturnType<typeof useSessionSearch>["state"], count: number): string {
  if (state === "loading") return "正在搜索聊天记录";
  if (state === "loadingMore") return `正在加载更多，当前 ${count} 条记录`;
  if (state === "success") return `找到 ${count} 条记录`;
  if (state === "empty") return "没有找到匹配的聊天记录";
  if (state === "error") return "聊天记录搜索失败";
  return "请输入搜索内容";
}

/** 空态、错误和初始引导已有可见正文，仅保留隐藏播报避免重复显示。 */
function statusVisuallyHidden(state: ReturnType<typeof useSessionSearch>["state"]): boolean {
  return state === "idle" || state === "empty" || state === "error";
}

function formatTimestamp(timestamp: string): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return timestamp;
  return new Intl.DateTimeFormat("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(date);
}
