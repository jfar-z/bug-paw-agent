import { Archive, Clock3, MessageSquare, MessageSquarePlus, Pin, RefreshCw, Search, Trash2, X } from "lucide-react";
import { useRef, useState } from "react";
import type { CSSProperties, PointerEvent as ReactPointerEvent, TouchEvent as ReactTouchEvent } from "react";

import { sortSessionsPinnedFirst } from "../../../../shared/session-sort";
import type { SessionSummary } from "../../../api";
import type { IdentityPreview } from "../chat-types";
import { SessionActionsMenu } from "../../../components/session-actions-menu";
import { SecondarySidebarHeader } from "../../../ui/sidebar-header";
import { UserAvatar } from "./user-avatar";

interface ChatSidebarProps {
  open: boolean;
  sessions: SessionSummary[];
  activeSessionId?: string;
  openingSessionId?: string;
  scrolling: boolean;
  noAvailableAgent: boolean;
  streaming: boolean;
  refreshing: boolean;
  profileIdentity: IdentityPreview;
  actionsOpenRequest?: { sessionId: string; requestId: number };
  selectionMode: boolean;
  selectedSessionIds: string[];
  bulkBusy?: boolean;
  swipeTranslatePercent?: number;
  swiping?: boolean;
  onClose(): void;
  onEnterDraft(): void;
  onRefresh(): void;
  onSearch(): void;
  onScroll(): void;
  onPointerDown(sessionId: string, event: ReactPointerEvent<HTMLButtonElement>): void;
  onPointerEnd(): void;
  onOpen(sessionId: string): void;
  shouldSuppressOpen(sessionId: string): boolean;
  onRename(sessionId: string, name: string): void;
  onPinChange(sessionId: string, pinned: boolean): Promise<boolean>;
  onArchive(sessionId: string): void;
  onDelete(sessionId: string, confirmBoundTasks: boolean): void;
  onEnterSelection(sessionId: string): void;
  onToggleSelection(sessionId: string): void;
  onCancelSelection(): void;
  onBulkArchive(): void;
  onBulkDelete(): void;
  onShowArchived(): void;
  onEditProfile(): void;
}

const selectionActionStyle: CSSProperties = { display: "grid", flex: 1, minHeight: 42, placeItems: "center", border: 0, borderRadius: 7, color: "var(--text-secondary)", background: "transparent", fontSize: 10 };
const sessionGroupLabelStyle: CSSProperties = { display: "flex", alignItems: "center", gap: 5 };
const pinStatusStyle: CSSProperties = { flex: "0 0 auto", color: "var(--accent)", transform: "rotate(-7deg)" };
const taskStatusStyle: CSSProperties = { flex: "0 0 auto" };

/** 会话侧栏仅负责展示与手势转发，不持有请求或领域状态。 */
export function ChatSidebar(props: ChatSidebarProps) {
  const isOpeningSession = props.openingSessionId !== undefined;
  const sortedSessions = sortSessionsPinnedFirst(props.sessions);
  const pinnedSessions = sortedSessions.filter((session) => session.pinned);
  const recentSessions = sortedSessions.filter((session) => !session.pinned);
  const sessionGroups = [
    ...(pinnedSessions.length ? [{ label: "置顶", ariaLabel: "置顶会话", sessions: pinnedSessions }] : []),
    { label: "最近", ariaLabel: "最近会话", sessions: recentSessions },
  ];
  const pullStartYRef = useRef<number | undefined>(undefined);
  const [pullDistance, setPullDistance] = useState(0);
  const refreshReady = pullDistance >= 64;
  // 横向触摸由根手势处理器结算关闭，纵向滚动仍保持浏览器原生行为。
  const sidebarStyle: CSSProperties = {
    touchAction: "pan-y",
    ...(props.swipeTranslatePercent === undefined ? {} : { transform: `translateX(${props.swipeTranslatePercent}%)` }),
  };

  /** 仅在列表滚动到顶部时记录移动端下拉手势。 */
  function startPullToRefresh(event: ReactTouchEvent<HTMLElement>) {
    if (props.refreshing || event.currentTarget.scrollTop > 0) return;
    pullStartYRef.current = event.touches[0]?.clientY;
  }

  /** 记录下拉距离，为释放刷新提供轻量视觉反馈。 */
  function trackPullToRefresh(event: ReactTouchEvent<HTMLElement>) {
    if (pullStartYRef.current === undefined) return;
    const distance = Math.max(0, (event.touches[0]?.clientY ?? pullStartYRef.current) - pullStartYRef.current);
    setPullDistance(Math.min(distance, 88));
  }

  /** 下拉达到阈值后刷新，普通滚动不会触发列表请求。 */
  function finishPullToRefresh() {
    if (refreshReady && !props.refreshing) props.onRefresh();
    pullStartYRef.current = undefined;
    setPullDistance(0);
  }

  return <>
    {props.open && <button type="button" className="sidebar-scrim" aria-label="关闭会话侧栏" onClick={props.onClose} />}
    <aside
      aria-label="会话历史"
      className={`chat-sidebar${props.open ? " is-open" : ""}${props.swiping ? " is-swiping" : ""}`}
      style={sidebarStyle}
    >
      <SecondarySidebarHeader
        className="sidebar-header live-session-header"
        eyebrow={props.selectionMode ? "SELECT SESSIONS" : "SESSIONS"}
        title={props.selectionMode ? `已选 ${props.selectedSessionIds.length} 项` : "会话"}
        actionsProps={{ className: "live-session-header__actions", role: "group", "aria-label": "会话列表操作" }}
        actions={<>
          <button type="button" className="session-refresh-button session-search-button" aria-label="搜索聊天记录" title="搜索聊天记录" disabled={props.noAvailableAgent || isOpeningSession || props.selectionMode} onClick={props.onSearch}><Search size={15} aria-hidden="true" /></button>
          <button type="button" className="session-refresh-button" aria-label="刷新会话列表" title="刷新会话列表" disabled={props.refreshing || isOpeningSession || props.selectionMode} onClick={props.onRefresh}><RefreshCw size={15} aria-hidden="true" className={props.refreshing ? "is-spinning" : undefined} /></button>
        </>}
      />
      <button type="button" className="new-chat-button" onClick={props.onEnterDraft} disabled={props.noAvailableAgent || isOpeningSession || props.selectionMode}>
        <MessageSquarePlus size={18} aria-hidden="true" /><span>新对话</span>
      </button>
      <nav className={`session-nav${props.scrolling ? " is-scrolling" : ""}${pullDistance > 0 ? " is-pulling" : ""}`} style={{ touchAction: "pan-y" }} aria-label="会话历史" onScroll={props.onScroll} onTouchStart={startPullToRefresh} onTouchMove={trackPullToRefresh} onTouchEnd={finishPullToRefresh} onTouchCancel={finishPullToRefresh}>
        {pullDistance > 0 ? <div className="session-refresh-hint" aria-live="polite" style={{ height: pullDistance }}><RefreshCw size={14} aria-hidden="true" className={refreshReady ? "is-ready" : undefined} /><span>{refreshReady ? "松开刷新" : "下拉刷新"}</span></div> : null}
        {sessionGroups.map((group, index) => <section className="session-group" role="group" aria-label={group.ariaLabel} key={group.ariaLabel} style={index > 0 ? { marginTop: 16 } : undefined}>
          <p style={sessionGroupLabelStyle}>{group.label === "置顶" ? <Pin size={11} aria-hidden="true" /> : null}{group.label}</p>
        {group.sessions.map((item) => {
          const title = item.name || item.firstMessage || "新对话";
          const selectionDisabled = isOpeningSession || (props.streaming && item.id === props.activeSessionId);
          return (
          <div className={`session-row${item.id === props.activeSessionId ? " is-active" : ""}${item.id === props.openingSessionId ? " is-opening" : ""}`} key={item.id}>
            {props.selectionMode ? <label className={`session-row__open session-row__select${selectionDisabled ? " is-disabled" : ""}`} style={{ display: "flex", alignItems: "center", color: "var(--text-secondary)", cursor: selectionDisabled ? "not-allowed" : "pointer", opacity: selectionDisabled ? 0.62 : 1 }}>
              <input
                type="checkbox"
                style={{ width: 15, height: 15, margin: 0, flex: "0 0 auto", accentColor: "var(--accent)" }}
                aria-label={`选择 ${title}`}
                checked={props.selectedSessionIds.includes(item.id)}
                disabled={selectionDisabled}
                onChange={() => props.onToggleSelection(item.id)}
              />
              <MessageSquare size={16} aria-hidden="true" />
              <span className="session-row__title">{title}</span>
              {props.streaming && item.id === props.activeSessionId ? <small>生成中</small> : null}
              {item.pinned ? <Pin className="session-row__pin" style={pinStatusStyle} size={13} aria-label="已置顶" /> : null}
              {item.scheduledTaskCount ? <Clock3 className="session-row__task" style={taskStatusStyle} size={14} aria-label={`已绑定 ${item.scheduledTaskCount} 个定时任务`} /> : null}
            </label> : <><button
              type="button"
              className="session-row__open"
              disabled={isOpeningSession}
              aria-busy={item.id === props.openingSessionId || undefined}
              onPointerDown={(event) => props.onPointerDown(item.id, event)}
              onPointerUp={props.onPointerEnd}
              onPointerCancel={props.onPointerEnd}
              onPointerLeave={props.onPointerEnd}
              onContextMenu={(event) => event.preventDefault()}
              onClick={() => { if (!props.shouldSuppressOpen(item.id)) props.onOpen(item.id); }}
            >
              <MessageSquare size={16} aria-hidden="true" />
              <span className="session-row__title">{title}</span>
              {item.pinned ? <Pin className="session-row__pin" style={pinStatusStyle} size={13} aria-label="已置顶" /> : null}
              {item.scheduledTaskCount ? <Clock3 className="session-row__task" style={taskStatusStyle} size={14} aria-label={`已绑定 ${item.scheduledTaskCount} 个定时任务`} /> : null}
            </button>
            <SessionActionsMenu
              session={item}
              disabled={isOpeningSession || (props.streaming && item.id === props.activeSessionId)}
              openRequestId={props.actionsOpenRequest?.sessionId === item.id ? props.actionsOpenRequest.requestId : undefined}
              onPinChange={(pinned) => props.onPinChange(item.id, pinned)}
              onRename={(name) => props.onRename(item.id, name)}
              onArchive={() => props.onArchive(item.id)}
              onDelete={(confirmBoundTasks) => props.onDelete(item.id, confirmBoundTasks)}
              onSelectMultiple={() => props.onEnterSelection(item.id)}
            />
            </>}
          </div>
        ); })}
        </section>)}
      </nav>
      {props.selectionMode ? <div className="session-selection-toolbar" style={{ display: "flex", gap: 5, margin: "8px 0" }} aria-label="会话多选操作">
        <button type="button" style={selectionActionStyle} aria-label="归档已选会话" disabled={props.selectedSessionIds.length === 0 || props.bulkBusy} onClick={props.onBulkArchive}><Archive size={15} aria-hidden="true" /><span>归档</span></button>
        <button type="button" style={{ ...selectionActionStyle, color: "var(--danger)" }} className="is-danger" aria-label="删除已选会话" disabled={props.selectedSessionIds.length === 0 || props.bulkBusy} onClick={props.onBulkDelete}><Trash2 size={15} aria-hidden="true" /><span>删除</span></button>
        <button type="button" style={selectionActionStyle} aria-label="取消多选" disabled={props.bulkBusy} onClick={props.onCancelSelection}><X size={15} aria-hidden="true" /><span>取消</span></button>
      </div> : <button type="button" className="archived-chat-button" aria-label="查看已归档会话" disabled={isOpeningSession} onClick={props.onShowArchived}>
        <Archive size={16} aria-hidden="true" /><span>已归档</span>
      </button>}
      <div className="sidebar-footer"><button type="button" className="account-button" aria-label="编辑个人资料" onClick={props.onEditProfile}><UserAvatar identity={props.profileIdentity} className="avatar" /><span><strong>{props.profileIdentity.displayName}</strong><small>本地工作区</small></span></button></div>
    </aside>
  </>;
}
