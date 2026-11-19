import { ChevronDown, CircleStop, FolderOpen, Menu, MessageSquarePlus, PencilLine, Send } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { flushSync } from "react-dom";
import type { ChatRunSummary, WorkspaceFileSummary } from "../../shared/contracts";
import type { AgentProfileDocument } from "../../shared/agent-contracts";
import type { AvatarCropArea } from "../../shared/avatar-contracts";
import { classifyAssistantRunOutcome } from "../../shared/assistant-run-outcome";
import type { SessionTextSearchHit } from "../../shared/session-text-search";
import { sortSessionsPinnedFirst } from "../../shared/session-sort";
import { api, type ModelSummary, type SessionBulkAction, type SessionBulkPreview, type SessionBulkTarget, type SessionSnapshot, type SessionSummary } from "../api";
import { useApiTask, type ApiTaskPolicy } from "../api-task-provider";
import { AgentModelMenu } from "../components/agent-model-menu";
import { AttachmentPicker, AttachmentPickerButton, type AttachmentUploadItem, validateAttachmentSelection } from "../components/attachment-picker";
import { ReferenceComposer } from "../components/reference-composer";
import { MediaLightbox } from "../components/media-lightbox";
import { DataFilePreviewDialog } from "../components/data-file-preview-dialog";
import { ArchivedSessionsDialog } from "../components/archived-sessions-dialog";
import { SessionBulkConfirmationDialog } from "../components/session-bulk-confirmation-dialog";
import { SessionSearchDialog } from "../components/session-search-dialog";
import { QuickWorkspaceDrawer } from "../components/quick-workspace-drawer";
import {
  parsePiHistory,
  reduceTimeline,
  type AgentTurn,
  type ConversationEntry,
  type UserEntry,
} from "../conversation-timeline";
import type { ThemePreference } from "../theme";
import { useMessageAutofollow } from "../use-message-autofollow";
import { useViewportScrollLock } from "../use-viewport-scroll-lock";
import { useSessionStream } from "../use-session-stream";
import { useSessionHistory } from "../use-session-history";
import { mergeCommittedTurn, mergeNewerHistory, mergeOlderHistory, reconcileSnapshotMessages } from "../session-history";
import {
  createPendingUserMessage,
  reconcilePendingUserMessage,
  type PendingUserMessage,
} from "../pending-user-message";
import {
  createPendingQuestionResponse,
  reconcilePendingQuestionResponse,
  type PendingQuestionResponse,
} from "../pending-question-response";
import { createSessionListSync, type SessionListSync } from "../session-sync";
import { navigateTo, WORKBENCH_NAVIGATION_TOGGLE_EVENT } from "../router";
import type { AgentReference } from "../../shared/agent-reference-contracts";
import { ChatSidebar } from "../features/chat/components/chat-sidebar";
import { ConversationTimelineView } from "../features/chat/components/conversation-timeline-view";
import { ChatMediaDeleteConfirmation } from "../features/chat/components/media-delete-confirmation";
import { ProfileDialog } from "../features/chat/components/profile-dialog";
import type { IdentityPreview } from "../features/chat/chat-types";
import { ChatInteractionCoordinator, type ChatInteractionTicket } from "../features/chat/chat-interaction-coordinator";
import { isSameModel, useChatRuntimeControls } from "../features/chat/use-chat-runtime-controls";
import { useMobileWorkspaceSwipe, type MobileWorkspaceDrawer } from "../features/chat/mobile-workspace-swipe";
import { classifyDataFileLink } from "../workspace-links";
import { agentTurnSpeechText, prepareSpeechSegments } from "../speech-text";
import { StreamingTtsController, type SpeechPlaybackState } from "../streaming-tts-controller";
import { PcmStreamAudio } from "../pcm-stream-audio";
import { ComposerSessionControls } from "../components/composer-session-controls";
import { ServerSpeechInputButton } from "../components/server-speech-input-button";
import { QuestionComposer } from "../components/question-composer";
import { AvatarCropDialog } from "../components/avatar/avatar-crop-dialog";
import { validateAvatarFile } from "../components/avatar/avatar-file";
import { useQuestionDraft } from "../use-question-draft";
import { removeQuestionDraft } from "../question-draft-store";
import type { PendingQuestionProjection, SubmittedQuestionAnswer } from "../../shared/session-question-contracts";

interface LiveChatPageProps {
  theme: ThemePreference;
  userIdentity: IdentityPreview;
}

/** 将识别文本追加到草稿；仅在英文单词边界补空格，避免破坏中文语句。 */
function appendSpeechTranscript(current: string, transcript: string): string {
  const normalized = transcript.trim();
  if (!normalized) return current;
  if (!current) return normalized;
  const needsSpace = /[a-z\d]$/iu.test(current) && /^[a-z\d]/iu.test(normalized);
  return `${current}${needsSpace ? " " : ""}${normalized}`;
}

interface AutoSpeechEligibility {
  /** 用户本次发送所在的 Session。 */
  sessionId: string;

  /** 发送前最后一个 Agent turn，用于排除历史回答。 */
  previousTurnId?: string;

  /** 本次发送后绑定的新 Agent turn。 */
  turnId?: string;
}

interface SpeechControllerEntry {
  /** 控制器绑定的 Agent。 */
  agentId: string;

  /** 负责该 Agent 合成请求的播放控制器。 */
  controller: StreamingTtsController;
}

type SnapshotAlignment = "follow" | "once";

interface FocusedHistory {
  /** 当前聚焦读取的 Session。 */
  sessionId: string;

  /** 搜索命中的稳定 Pi entry ID。 */
  entryId: string;
}

const SELECTED_AGENT_STORAGE_KEY = "pi-agent-web.selected-agent-id";
const SESSION_LONG_PRESS_DURATION_MS = 450;
const SESSION_SCROLLBAR_HIDE_DELAY_MS = 700;
const SESSION_SEARCH_FOCUS_OFFSET = 24;
const SESSION_SEARCH_TARGET_ATTEMPTS = 12;
const SESSION_SEARCH_HIGHLIGHT_DURATION_MS = 1_600;
const EMPTY_PENDING_QUESTION: PendingQuestionProjection = {
  id: "none",
  version: 1,
  toolCallId: "none",
  createdAt: "1970-01-01T00:00:00.000Z",
  questions: [{
    id: "none",
    header: "提问",
    question: "暂无问题",
    multiSelect: false,
    options: [
      { id: "none-1", label: "选项一", description: "占位选项" },
      { id: "none-2", label: "选项二", description: "占位选项" },
    ],
  }],
};

/** 将聊天、会话、模型和附件的可恢复业务错误保留在编辑器附近。 */
function chatExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_MESSAGE: show,
    INVALID_ATTACHMENT: show,
    INVALID_REFERENCE: show,
    UNKNOWN_COMMAND: show,
    SESSION_BUSY: show,
    SESSION_AWAITING_USER: show,
    QUESTION_NOT_FOUND: show,
    QUESTION_STATE_CONFLICT: show,
    QUESTION_VERSION_CONFLICT: show,
    QUESTION_BRANCH_CHANGED: show,
    QUESTION_ANSWER_INVALID: show,
    SESSION_NOT_FOUND: show,
    SESSION_ARCHIVED: show,
    SESSION_AGENT_CONFLICT: show,
    AGENT_ARCHIVED: show,
    INVALID_SESSION_NAME: show,
    SCHEDULED_TASKS_BOUND: show,
    SESSION_BULK_PREVIEW_STALE: show,
    SESSION_AGENT_MISSING: show,
    OPERATION_ABORTED: show,
    RUNTIME_GENERATION_RETIRED: show,
    CLIENT_TOO_SLOW: show,
    VALIDATION_FAILED: show,
    INVALID_MODEL: show,
    MODEL_NOT_FOUND: show,
    PROVIDER_NOT_FOUND: show,
    MODEL_RUNTIME_UNAVAILABLE: show,
    EMPTY_UPLOAD: show,
    ATTACHMENT_TOO_LARGE: show,
    TOO_MANY_ATTACHMENTS: show,
    AGENT_NOT_FOUND: show,
  };
}

/** 头像处理错误留在裁剪器内，便于用户保留位置和缩放后重试。 */
function avatarExpected(setError: (message: string) => void): ApiTaskPolicy["expected"] {
  const show = (error: { message: string }) => setError(error.message);
  return {
    INVALID_AVATAR_CROP: show,
    AVATAR_TOO_LARGE: show,
    INVALID_AVATAR_TYPE: show,
    AVATAR_TOO_MANY_PIXELS: show,
    AVATAR_PROCESSING_FAILED: show,
    VERSION_CONFLICT: show,
  };
}

/** 从权威快照提取当前一轮的安全模型提示。 */
function modelRunNotice(messages: readonly unknown[]): string {
  const outcome = classifyAssistantRunOutcome(messages);
  if (outcome.status === "error") return outcome.message;
  return outcome.status === "completed" && "notice" in outcome ? outcome.notice : "";
}

/**
 * 接入真实会话 API 与 SSE 的第一版对话工作台。
 */
export function LiveChatPage({ theme, userIdentity }: LiveChatPageProps) {
  useViewportScrollLock();
  const { runApiTask, runOptionalApiTask } = useApiTask();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [resourcesOpen, setResourcesOpen] = useState(false);
  const [workspaceLocationRequest, setWorkspaceLocationRequest] = useState<{ id: number; path: string }>();
  const [workspaceMessage, setWorkspaceMessage] = useState("");
  const workspaceTriggerRef = useRef<HTMLElement | undefined>(undefined);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [archivedSessions, setArchivedSessions] = useState<SessionSummary[]>([]);
  const [archiveDialogOpen, setArchiveDialogOpen] = useState(false);
  const [sessionSearchOpen, setSessionSearchOpen] = useState(false);
  const [sessionSelectionMode, setSessionSelectionMode] = useState(false);
  const [selectedSessionIds, setSelectedSessionIds] = useState<string[]>([]);
  const [sessionBulkPreview, setSessionBulkPreview] = useState<SessionBulkPreview>();
  const [sessionBulkBusy, setSessionBulkBusy] = useState(false);
  const [models, setModels] = useState<ModelSummary[]>([]);
  const [agents, setAgents] = useState<AgentProfileDocument[]>([]);
  const [selectedAgentId, setSelectedAgentId] = useState<string>();
  const [globalDefaultModel, setGlobalDefaultModel] = useState<{ provider: string; id: string }>();
  const [openingSessionId, setOpeningSessionId] = useState<string>();
  const [suspendedSessionStreamId, setSuspendedSessionStreamId] = useState<string>();
  const [session, setSession] = useState<SessionSnapshot>();
  const [timeline, setTimeline] = useState<ConversationEntry[]>([]);
  const [focusedHistory, setFocusedHistory] = useState<FocusedHistory>();
  const [focusedEntryId, setFocusedEntryId] = useState<string>();
  const [mediaSummaries, setMediaSummaries] = useState<Record<string, WorkspaceFileSummary>>({});
  const [previewImage, setPreviewImage] = useState<WorkspaceFileSummary>();
  const [previewFilePath, setPreviewFilePath] = useState<string>();
  const [draft, setDraft] = useState("");
  /** 正在编辑的历史用户消息；仅在实际发送时用于创建 Pi 分支。 */
  const [editingEntryId, setEditingEntryId] = useState<string>();
  const [draftReferences, setDraftReferences] = useState<AgentReference[]>([]);
  const [activeRun, setActiveRun] = useState<ChatRunSummary>();
  const [mediaDeleteError, setMediaDeleteError] = useState<{ sessionId: string; error: { code: string; message: string } }>();
  const [questionSubmitting, setQuestionSubmitting] = useState(false);
  const [error, setError] = useState("");
  const [runNotice, setRunNotice] = useState("");
  const reportFailure = useCallback((reason: unknown, operation: string) => runApiTask(
    async () => { throw reason; },
    { operation, expected: chatExpected(setError) },
  ), [runApiTask]);
  const [attachmentItems, setAttachmentItems] = useState<AttachmentUploadItem[]>([]);
  const editingEntry = editingEntryId
    ? timeline.find((entry): entry is UserEntry => entry.type === "user" && entry.piEntryId === editingEntryId)
    : undefined;
  const [profileIdentity, setProfileIdentity] = useState<IdentityPreview>(userIdentity);
  const [profileRevision, setProfileRevision] = useState<string>();
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileDisplayName, setProfileDisplayName] = useState(userIdentity.displayName);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileAvatarFile, setProfileAvatarFile] = useState<File>();
  const [profileAvatarError, setProfileAvatarError] = useState("");
  const [sessionNavScrolling, setSessionNavScrolling] = useState(false);
  const [refreshingSessions, setRefreshingSessions] = useState(false);
  const sessionSyncRef = useRef<SessionListSync | undefined>(undefined);
  const openingSessionRef = useRef<string | undefined>(undefined);
  const sessionLongPressTimerRef = useRef<number | undefined>(undefined);
  const sessionScrollHideTimerRef = useRef<number | undefined>(undefined);
  const suppressSessionOpenRef = useRef<string | undefined>(undefined);
  const [sessionActionsOpenRequest, setSessionActionsOpenRequest] = useState<{ sessionId: string; requestId: number }>();
  const initialSseSnapshotRef = useRef<{ id: string; lastEventId: number } | undefined>(undefined);
  const pendingUserMessageRef = useRef<PendingUserMessage | undefined>(undefined);
  const pendingQuestionResponseRef = useRef<PendingQuestionResponse | undefined>(undefined);
  const streamRunRevisionRef = useRef(0);
  const selectedAgentIdRef = useRef<string | undefined>(selectedAgentId);
  const sessionIdRef = useRef<string | undefined>(session?.id);
  const sessionSnapshotRef = useRef<SessionSnapshot | undefined>(session);
  const focusedHistoryRef = useRef<FocusedHistory | undefined>(focusedHistory);
  const focusHighlightTimerRef = useRef<number | undefined>(undefined);
  const autoSpeechEligibilityRef = useRef<AutoSpeechEligibility | undefined>(undefined);
  const speechControllerRef = useRef<SpeechControllerEntry | undefined>(undefined);
  const pageMountedRef = useRef(false);
  const interactionCoordinatorRef = useRef<ChatInteractionCoordinator | undefined>(undefined);
  interactionCoordinatorRef.current ??= new ChatInteractionCoordinator();
  const interactionCoordinator = interactionCoordinatorRef.current;
  const [speechState, setSpeechState] = useState<SpeechPlaybackState>({ phase: "idle" });
  selectedAgentIdRef.current = selectedAgentId;
  sessionIdRef.current = session?.id;
  sessionSnapshotRef.current = session;
  focusedHistoryRef.current = focusedHistory;
  const pendingQuestion = session?.pendingQuestion;
  const questionDraft = useQuestionDraft(session?.id ?? "none", pendingQuestion ?? EMPTY_PENDING_QUESTION);
  const previousPendingRef = useRef<{ sessionId: string; pending: PendingQuestionProjection } | undefined>(undefined);
  const {
    scrollContainerRef: messageScrollRef,
    contentRef: messageContentRef,
    resumeFollowing,
    pauseFollowing,
    alignAfterNextContentCommit,
  } = useMessageAutofollow(timeline);

  useEffect(() => {
    pageMountedRef.current = true;
    return () => {
      pageMountedRef.current = false;
      interactionCoordinator.invalidateAll("page-unmounted");
    };
  }, [interactionCoordinator]);

  /** 页面仍挂载且交互代次有效时才允许异步结果回写。 */
  const guardInteraction = useCallback((ticket: ChatInteractionTicket, checkpoint: string): boolean => (
    pageMountedRef.current && interactionCoordinator.guard(ticket, checkpoint)
  ), [interactionCoordinator]);

  /** 按代次接纳同类会话列表读取，阻止跨标签同步和手动刷新乱序覆盖。 */
  const loadSessionSummaries = useCallback(async (
    agentId: string,
    archived: boolean,
    source: string,
  ): Promise<SessionSummary[] | undefined> => {
    const channel = archived ? "archived-session-list" as const : "session-list" as const;
    const ticket = interactionCoordinator.begin(channel, { agentId, source });
    try {
      const result = await api.listSessions(agentId, archived);
      if (!guardInteraction(ticket, "session-list-response")) return undefined;
      if (selectedAgentIdRef.current !== agentId) {
        interactionCoordinator.finish(ticket, "applied", { ignoredAgentChange: true });
        return undefined;
      }
      interactionCoordinator.finish(ticket, "applied", { count: result.sessions.length });
      return result.sessions;
    } catch (reason) {
      if (!guardInteraction(ticket, "session-list-error")) return undefined;
      interactionCoordinator.finish(ticket, "failed");
      throw reason;
    }
  }, [guardInteraction, interactionCoordinator]);

  /** 同步 Session 权威运行时字段，并保持命令式快照引用与 React 状态一致。 */
  const applySessionRuntimeChange = useCallback((targetSessionId: string, patch: {
    model?: ModelSummary;
    thinkingLevel?: SessionSnapshot["thinkingLevel"];
  }) => {
    setSession((current) => {
      if (!current || current.id !== targetSessionId) return current;
      const next = { ...current, ...patch };
      sessionSnapshotRef.current = next;
      return next;
    });
  }, []);

  const {
    selectedModel,
    selectedThinkingLevel,
    runtimeChanging,
    applySnapshotRuntime,
    initializeForAgent,
    applyModelEvent,
    applyThinkingLevelEvent,
    changeModel,
    changeThinkingLevel,
    invalidateSessionRuntime,
  } = useChatRuntimeControls({
    coordinator: interactionCoordinator,
    guardInteraction,
    onSessionRuntimeChange: applySessionRuntimeChange,
    onFailure: reportFailure,
  });

  /** 会话归属变化时废弃所有可能回写旧会话的异步动作。 */
  const invalidateSessionInteractions = (reason: string) => {
    interactionCoordinator.invalidate("branch-navigation", reason);
    interactionCoordinator.invalidate("history-edit", reason);
    interactionCoordinator.invalidate("message-send", reason);
    interactionCoordinator.invalidate("projection-refresh", reason);
    interactionCoordinator.invalidate("question-submission", reason);
    invalidateSessionRuntime(reason);
    setQuestionSubmitting(false);
  };

  /** 以权威 Run 投影更新按钮状态，并使更早发出的请求响应失效。 */
  const applyAuthoritativeRun = useCallback((run: ChatRunSummary | undefined) => {
    streamRunRevisionRef.current += 1;
    setActiveRun(run?.status === "queued" || run?.status === "running" ? run : undefined);
  }, []);

  const applySnapshot = useCallback((next: SessionSnapshot, alignment: SnapshotAlignment = "follow") => {
    applyAuthoritativeRun(next.run);
    if (alignment === "once") {
      initialSseSnapshotRef.current = { id: next.id, lastEventId: next.lastEventId };
      alignAfterNextContentCommit();
    } else {
      const initialSseSnapshot = initialSseSnapshotRef.current;
      initialSseSnapshotRef.current = undefined;
      if (initialSseSnapshot?.id === next.id && initialSseSnapshot.lastEventId === next.lastEventId) {
        return;
      }
      resumeFollowing();
    }
    const reconciled = reconcileSnapshotMessages(sessionSnapshotRef.current, next);
    const mergedSnapshot = { ...next, messages: reconciled.messages };
    sessionSnapshotRef.current = mergedSnapshot;
    setSession(mergedSnapshot);
    setRunNotice(modelRunNotice(mergedSnapshot.messages));
    applySnapshotRuntime(next);
    const running = next.run?.status === "queued" || next.run?.status === "running";
    const pendingResult = reconcilePendingUserMessage(
      next.id,
      parsePiHistory(mergedSnapshot.messages, running),
      pendingUserMessageRef.current,
    );
    pendingUserMessageRef.current = pendingResult.pending;
    const branchToken = mergedSnapshot.history?.branchToken;
    if (branchToken) {
      const responseResult = reconcilePendingQuestionResponse(
        next.id,
        branchToken,
        pendingResult.timeline,
        pendingQuestionResponseRef.current,
      );
      pendingQuestionResponseRef.current = responseResult.pending;
      setTimeline(responseResult.timeline);
    } else {
      // 旧版快照缺少分支身份时不跨未知分支回填，仅保留原有投影行为。
      setTimeline(pendingResult.timeline);
    }
  }, [alignAfterNextContentCommit, applyAuthoritativeRun, applySnapshotRuntime, resumeFollowing]);

  useEffect(() => {
    const previous = previousPendingRef.current;
    if (previous && (previous.sessionId !== session?.id
      || previous.pending.id !== pendingQuestion?.id
      || previous.pending.version !== pendingQuestion?.version)) {
      removeQuestionDraft(previous.sessionId, previous.pending);
    }
    previousPendingRef.current = session && pendingQuestion
      ? { sessionId: session.id, pending: pendingQuestion }
      : undefined;
  }, [pendingQuestion, session]);

  /** 聚焦阅读期间只接收实时状态字段，避免最新正文覆盖当前历史窗口。 */
  const applyStreamSnapshot = useCallback((next: SessionSnapshot) => {
    if (focusedHistoryRef.current?.sessionId !== next.id) {
      applySnapshot(next);
      return;
    }
    applyAuthoritativeRun(next.run);
    setSession((current) => {
      if (!current || current.id !== next.id) return current;
      const merged = {
        ...current,
        ...(next.agentId ? { agentId: next.agentId } : {}),
        ...(next.model ? { model: next.model } : {}),
        ...(next.thinkingLevel ? { thinkingLevel: next.thinkingLevel } : {}),
        run: next.run,
        pendingQuestion: next.pendingQuestion,
        lastEventId: next.lastEventId,
      };
      sessionSnapshotRef.current = merged;
      return merged;
    });
    applySnapshotRuntime(next);
  }, [applyAuthoritativeRun, applySnapshot, applySnapshotRuntime]);

  const historyLoader = useSessionHistory({
    snapshot: session,
    focused: Boolean(focusedHistory),
    scrollRef: messageScrollRef,
    onBeforePrepend: pauseFollowing,
    onPrepend: (page) => {
      setSession((current) => {
        if (!current || current.id !== page.sessionId || current.history.branchToken !== page.history.branchToken) return current;
        const messages = mergeOlderHistory(current.messages, page.messages);
        const merged = {
          ...current,
          messages,
          history: {
            ...page.history,
            endEntryId: current.history.endEntryId,
            hasMoreAfter: current.history.hasMoreAfter,
          },
        };
        sessionSnapshotRef.current = merged;
        const pendingResult = reconcilePendingUserMessage(
          current.id,
          parsePiHistory(messages, current.run?.status === "queued" || current.run?.status === "running"),
          pendingUserMessageRef.current,
        );
        pendingUserMessageRef.current = pendingResult.pending;
        setTimeline(pendingResult.timeline);
        return merged;
      });
    },
    onAppend: (page) => {
      setSession((current) => {
        if (!current || current.id !== page.sessionId || current.history.branchToken !== page.history.branchToken) return current;
        const messages = mergeNewerHistory(current.messages, page.messages);
        const merged = {
          ...current,
          messages,
          history: {
            ...page.history,
            startEntryId: current.history.startEntryId,
            hasMoreBefore: current.history.hasMoreBefore,
          },
        };
        sessionSnapshotRef.current = merged;
        setTimeline(parsePiHistory(messages, false));
        return merged;
      });
    },
    onError: (reason) => { void reportFailure(reason, "加载更早消息"); },
    onNewerError: (reason) => { void reportFailure(reason, "加载较新消息"); },
  });

  const stream = useSessionStream({
    // 切换或删除期间立即撤销旧 Session 的实时流归属，失败回退后会按原 Session 自动重连。
    sessionId: openingSessionId || suspendedSessionStreamId === session?.id ? undefined : session?.id,
    initialCursor: session?.lastEventId,
    onSnapshot: applyStreamSnapshot,
    onTurnCommitted: ({ id, messages: committedMessages, history }) => {
      const current = sessionSnapshotRef.current;
      if (!current || current.id !== sessionIdRef.current) return false;
      if (focusedHistoryRef.current?.sessionId === current.id) {
        const next = { ...current, lastEventId: id };
        sessionSnapshotRef.current = next;
        setSession(next);
        return true;
      }
      if (!current.history) return false;
      if (current.history.branchToken !== history.branchToken) return false;
      const messages = mergeCommittedTurn(current.messages, committedMessages);
      const next = {
        ...current,
        messages,
        history: {
          ...history,
          ...(current.history.startEntryId ? { startEntryId: current.history.startEntryId } : {}),
          hasMoreBefore: current.history.hasMoreBefore,
        },
        lastEventId: id,
      };
      sessionSnapshotRef.current = next;
      setSession(next);
      setRunNotice(modelRunNotice(messages));
      const pendingResult = reconcilePendingUserMessage(
        current.id,
        parsePiHistory(messages, true),
        pendingUserMessageRef.current,
      );
      pendingUserMessageRef.current = pendingResult.pending;
      const responseResult = reconcilePendingQuestionResponse(
        current.id,
        history.branchToken,
        pendingResult.timeline,
        pendingQuestionResponseRef.current,
      );
      pendingQuestionResponseRef.current = responseResult.pending;
      setTimeline(responseResult.timeline);
      return true;
    },
    onTimelineEvent: (event) => {
      if (!focusedHistoryRef.current) setTimeline((current) => reduceTimeline(current, event));
    },
    onRunChange: (run) => {
      applyAuthoritativeRun(run);
    },
    onModelChange: (model) => {
      const targetSessionId = sessionIdRef.current;
      if (targetSessionId) applyModelEvent(targetSessionId, model);
    },
    onThinkingLevelChange: (thinkingLevel) => {
      const targetSessionId = sessionIdRef.current;
      if (targetSessionId) applyThinkingLevelEvent(targetSessionId, thinkingLevel);
    },
    onSessionRenamed: (sessionId, name) => {
      setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, name } : item));
      sessionSyncRef.current?.notify();
    },
    onPendingQuestion: (nextPending) => {
      setQuestionSubmitting(false);
      setSession((current) => {
        if (!current) return current;
        const next = { ...current, pendingQuestion: nextPending };
        sessionSnapshotRef.current = next;
        return next;
      });
    },
    onQuestionResolved: ({ questionRecordId }) => {
      if (sessionSnapshotRef.current?.pendingQuestion?.id === questionRecordId) {
        questionDraft.clear();
        setQuestionSubmitting(false);
        setSession((current) => {
          if (!current || current.pendingQuestion?.id !== questionRecordId) return current;
          const next = { ...current, pendingQuestion: undefined };
          sessionSnapshotRef.current = next;
          return next;
        });
      }
      // SSE 不携带答案正文；复用游标保护流程暂停传输、刷新权威投影并续接后续事件。
      stream.refreshProjection();
    },
    onError: setRunNotice,
    onUnexpectedError: (reason) => void reportFailure(reason, "恢复会话实时连接"),
  });

  /** 请求当前 Session 的权威投影；异步返回时拒绝写入已经切换离开的会话。 */
  const refreshSessionProjection = useCallback(async (sessionId: string, alignment: SnapshotAlignment = "follow") => {
    const ticket = interactionCoordinator.begin("projection-refresh", { sessionId, alignment });
    try {
      const latest = await api.openSession(sessionId);
      if (!guardInteraction(ticket, "projection-response") || sessionIdRef.current !== sessionId) return undefined;
      const current = sessionSnapshotRef.current;
      if (current?.id === sessionId && latest.lastEventId < current.lastEventId) {
        interactionCoordinator.finish(ticket, "applied", { ignoredOlderProjection: true });
        return current;
      }
      applySnapshot(latest, alignment);
      interactionCoordinator.finish(ticket, "applied", { lastEventId: latest.lastEventId });
      return latest;
    } catch (reason) {
      if (interactionCoordinator.isCurrent(ticket)) interactionCoordinator.finish(ticket, "failed");
      throw reason;
    }
  }, [applySnapshot, guardInteraction, interactionCoordinator]);

  const registerMediaSummary = useCallback((summary: WorkspaceFileSummary) => {
    setMediaSummaries((current) => current[summary.path] === summary ? current : { ...current, [summary.path]: summary });
  }, []);

  const openImagePreview = useCallback((summary: WorkspaceFileSummary) => {
    if (!summary.mediaType.startsWith("image/")) return;
    registerMediaSummary(summary);
    setPreviewImage(summary);
  }, [registerMediaSummary]);
  const streaming = activeRun?.status === "queued" || activeRun?.status === "running";
  const isOpeningSession = openingSessionId !== undefined;
  // 连接状态独立于业务错误，重连成功后提示会自然撤销且不会误清其他错误。
  const composerError = error || runNotice || (stream.reconnecting ? "实时连接暂时中断，浏览器会自动重连。" : "");

  /** 获取当前 Agent 的唯一播放控制器，切换 Agent 时销毁旧实例。 */
  const ensureSpeechController = useCallback((agentId: string): StreamingTtsController => {
    const existing = speechControllerRef.current;
    if (existing?.agentId === agentId) {
      return existing.controller;
    }
    existing?.controller.destroy();
    const controller = new StreamingTtsController({
      request: async (text, signal) => {
        const response = await api.synthesizeAgentSpeech(agentId, text, signal);
        const mediaType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
        if (mediaType === "audio/pcm" && response.body) {
          const audio = new PcmStreamAudio(response.body);
          return { audio, release: () => audio.pause() };
        }
        return response.blob();
      },
      createAudio: (url) => new Audio(url),
      onStateChange: setSpeechState,
      onError: (reason) => {
        const blocked = reason instanceof DOMException && reason.name === "NotAllowedError";
        if (blocked) {
          setError("浏览器阻止了自动播放，请先与页面交互后重试。");
          return;
        }
        void reportFailure(reason, "播放语音");
      },
    });
    speechControllerRef.current = { agentId, controller };
    return controller;
  }, [reportFailure]);

  /** 清除自动播放资格并同步停止当前音频与待处理队列。 */
  const stopSpeech = useCallback(() => {
    autoSpeechEligibilityRef.current = undefined;
    speechControllerRef.current?.controller.stop();
  }, []);

  useEffect(() => () => {
    autoSpeechEligibilityRef.current = undefined;
    speechControllerRef.current?.controller.destroy();
    speechControllerRef.current = undefined;
  }, []);

  useEffect(() => {
    const ticket = interactionCoordinator.begin("agent-selection", { source: "bootstrap" });
    const globalSettingsTask = runOptionalApiTask(
      () => api.getGlobalSettings(),
      {
        operation: "加载全局默认模型",
        fallbackReason: "全局默认模型是聊天初始化的可选配置",
        fallback: () => undefined,
      },
    );
    Promise.all([api.listAgents(), api.listModels(), globalSettingsTask])
      .then(async ([agentResult, modelResult, globalSettingsResult]) => {
        if (!guardInteraction(ticket, "catalog-response")) return;
        const globalSettings = globalSettingsResult.status === "success" ? globalSettingsResult.data : undefined;
        const defaultProvider = globalSettings?.effective?.defaultProvider;
        const defaultModel = globalSettings?.effective?.defaultModel;
        const inheritedModel = defaultProvider && defaultModel ? { provider: defaultProvider, id: defaultModel } : undefined;
        const availableAgents = agentResult.agents.filter((item) => item.profile.status === "active");
        const cachedAgentId = readCachedAgentId();
        const cachedAgent = availableAgents.find((item) => item.profile.id === cachedAgentId);
        const initialAgent = cachedAgent ?? availableAgents[0];
        if (cachedAgentId && !cachedAgent) {
          clearCachedAgentId();
        }
        const initialAgentId = initialAgent?.profile.id;
        setAgents(availableAgents);
        selectedAgentIdRef.current = initialAgentId;
        setSelectedAgentId(initialAgentId);
        setModels(modelResult.models);
        setGlobalDefaultModel(inheritedModel);
        initializeForAgent(initialAgent, modelResult.models, inheritedModel);
        if (!initialAgentId) {
          interactionCoordinator.finish(ticket, "applied", { hasAgent: false });
          return;
        }
        const sessionSummaries = await loadSessionSummaries(initialAgentId, false, "bootstrap");
        if (!guardInteraction(ticket, "session-list-response")) return;
        if (!sessionSummaries) return;
        setSessions(sessionSummaries);
        if (sessionSummaries[0]) {
          const opened = await api.openSession(sessionSummaries[0].id);
          if (!guardInteraction(ticket, "initial-session-response")) return;
          applySnapshot(opened);
        }
        interactionCoordinator.finish(ticket, "applied", { hasAgent: true });
      })
      .catch((reason: unknown) => {
        if (!guardInteraction(ticket, "bootstrap-error")) return;
        interactionCoordinator.finish(ticket, "failed");
        void reportFailure(reason, "加载聊天工作台");
      });
    return () => {
      if (interactionCoordinator.isCurrent(ticket)) {
        interactionCoordinator.invalidate("agent-selection", "bootstrap-effect-cleanup");
      }
    };
  }, [applySnapshot, guardInteraction, initializeForAgent, interactionCoordinator, loadSessionSummaries, reportFailure, runOptionalApiTask]);

  useEffect(() => {
    let active = true;
    void api.getProfile().then((document) => {
      if (!active) return;
      setProfileRevision(document.revision);
      setProfileIdentity(toIdentityPreview(document.profile));
      setProfileDisplayName(document.profile.displayName);
    }).catch((reason: unknown) => {
      if (active) void reportFailure(reason, "加载个人资料");
    });
    return () => { active = false; };
  }, [reportFailure]);

  useEffect(() => {
    let active = true;
    const sync = createSessionListSync(() => {
      if (selectedAgentId) {
        void loadSessionSummaries(selectedAgentId, false, "broadcast")
          .then((result) => { if (active && result) setSessions(result); })
          .catch((reason: unknown) => { if (active) void reportFailure(reason, "同步会话列表"); });
        if (archiveDialogOpen) {
          void loadSessionSummaries(selectedAgentId, true, "broadcast")
            .then((result) => { if (active && result) setArchivedSessions(result); })
            .catch((reason: unknown) => { if (active) void reportFailure(reason, "同步归档会话"); });
        }
      }
    });
    sessionSyncRef.current = sync;
    return () => {
      active = false;
      sync.close();
    };
  }, [archiveDialogOpen, loadSessionSummaries, reportFailure, selectedAgentId]);

  const createConversation = async (agentId: string, ticket: ChatInteractionTicket) => {
    setError("");
    const created = await api.createSession(agentId);
    if (!guardInteraction(ticket, "create-session-response")) return undefined;
    flushSync(() => applySnapshot(created));
    return created;
  };

  /** 退出批量模式并清理尚未执行的确认预览。 */
  const cancelSessionSelection = () => {
    setSessionSelectionMode(false);
    setSelectedSessionIds([]);
    setSessionBulkPreview(undefined);
  };

  /** 统一所有侧栏关闭入口，保证选择不会跨抽屉生命周期残留。 */
  const closeSidebar = () => {
    cancelSessionSelection();
    setSidebarOpen(false);
  };
  const closeResources = () => {
    setResourcesOpen(false);
    window.setTimeout(() => workspaceTriggerRef.current?.focus(), 0);
  };
  /** 普通入口只打开当前目录，避免重放上一次 Markdown 文件定位。 */
  const openResources = () => {
    closeSidebar();
    setWorkspaceLocationRequest(undefined);
    setWorkspaceMessage("");
    setResourcesOpen(true);
  };
  const openDrawer = (drawer: MobileWorkspaceDrawer) => {
    if (drawer === "sessions") {
      setResourcesOpen(false);
      setSidebarOpen(true);
    } else {
      openResources();
    }
  };
  const workspaceSwipe = useMobileWorkspaceSwipe({
    openDrawer: sidebarOpen ? "sessions" : resourcesOpen ? "resources" : undefined,
    onOpenDrawer: openDrawer,
    onCloseDrawer: (drawer) => drawer === "sessions" ? closeSidebar() : closeResources(),
  });

  const resetToDraft = (draftAgent: AgentProfileDocument | undefined) => {
    invalidateSessionInteractions("enter-draft");
    interactionCoordinator.invalidate("session-transition", "enter-draft");
    openingSessionRef.current = undefined;
    setOpeningSessionId(undefined);
    setSuspendedSessionStreamId(undefined);
    stopSpeech();
    stream.close();
    focusedHistoryRef.current = undefined;
    setFocusedHistory(undefined);
    setFocusedEntryId(undefined);
    sessionSnapshotRef.current = undefined;
    setSession(undefined);
    setEditingEntryId(undefined);
    setTimeline([]);
    setMediaSummaries({});
    setPreviewImage(undefined);
    applyAuthoritativeRun(undefined);
    setDraft("");
    setDraftReferences([]);
    setAttachmentItems([]);
    setError("");
    setRunNotice("");
    pendingUserMessageRef.current = undefined;
    initializeForAgent(draftAgent, models, globalDefaultModel);
    closeSidebar();
  };

  const enterDraft = () => {
    resetToDraft(agents.find((item) => item.profile.id === selectedAgentId));
  };

  /** 仅当被移除 Session 仍是当前目标时退出，避免迟到响应清空已经切换的新会话。 */
  const leaveRemovedSessions = (removedSessionIds: ReadonlySet<string>) => {
    const openingSessionId = openingSessionRef.current;
    const currentSessionId = sessionIdRef.current;
    if ((openingSessionId && removedSessionIds.has(openingSessionId))
      || (!openingSessionId && currentSessionId && removedSessionIds.has(currentSessionId))) {
      enterDraft();
    }
  };

  const clearSessionLongPress = () => {
    if (sessionLongPressTimerRef.current === undefined) {
      return;
    }
    window.clearTimeout(sessionLongPressTimerRef.current);
    sessionLongPressTimerRef.current = undefined;
  };

  const clearSessionScrollbarTimer = () => {
    if (sessionScrollHideTimerRef.current === undefined) return;
    window.clearTimeout(sessionScrollHideTimerRef.current);
    sessionScrollHideTimerRef.current = undefined;
  };

  const showSessionNavScrollbar = () => {
    clearSessionScrollbarTimer();
    setSessionNavScrolling(true);
    sessionScrollHideTimerRef.current = window.setTimeout(() => {
      setSessionNavScrolling(false);
      sessionScrollHideTimerRef.current = undefined;
    }, SESSION_SCROLLBAR_HIDE_DELAY_MS);
  };

  const startSessionLongPress = (sessionId: string, event: ReactPointerEvent<HTMLButtonElement>) => {
    if (event.pointerType && event.pointerType !== "touch") {
      return;
    }
    clearSessionLongPress();
    sessionLongPressTimerRef.current = window.setTimeout(() => {
      // 长按后的合成点击不能再次打开会话。
      suppressSessionOpenRef.current = sessionId;
      setSessionActionsOpenRequest((current) => ({
        sessionId,
        requestId: (current?.requestId ?? 0) + 1,
      }));
      sessionLongPressTimerRef.current = undefined;
    }, SESSION_LONG_PRESS_DURATION_MS);
  };

  useEffect(() => () => {
    clearSessionLongPress();
    clearSessionScrollbarTimer();
    if (focusHighlightTimerRef.current !== undefined) window.clearTimeout(focusHighlightTimerRef.current);
  }, []);

  /** 在有限提交周期内寻找稳定 entry 锚点，并只移动消息滚动容器。 */
  const focusSessionEntry = async (entryId: string): Promise<boolean> => {
    for (let attempt = 0; attempt < SESSION_SEARCH_TARGET_ATTEMPTS; attempt += 1) {
      await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
      const container = messageScrollRef.current;
      const target = container
        ? [...container.querySelectorAll<HTMLElement>("[data-session-entry-id]")]
          .find((element) => element.dataset.sessionEntryId === entryId)
        : undefined;
      if (!container || !target) continue;
      container.scrollTop = container.scrollTop
        + target.getBoundingClientRect().top
        - container.getBoundingClientRect().top
        - SESSION_SEARCH_FOCUS_OFFSET;
      setFocusedEntryId(entryId);
      if (focusHighlightTimerRef.current !== undefined) window.clearTimeout(focusHighlightTimerRef.current);
      focusHighlightTimerRef.current = window.setTimeout(() => {
        setFocusedEntryId((current) => current === entryId ? undefined : current);
        focusHighlightTimerRef.current = undefined;
      }, SESSION_SEARCH_HIGHLIGHT_DURATION_MS);
      return true;
    }
    return false;
  };

  /** 丢弃聚焦窗口并重新读取 Session 的最新活动分支。 */
  const restoreLatestConversation = async (
    sessionId: string,
    ticket: ChatInteractionTicket,
  ): Promise<SessionSnapshot | undefined> => {
    const latest = await api.openSession(sessionId);
    if (!guardInteraction(ticket, "restore-latest-response") || sessionIdRef.current !== sessionId) return undefined;
    focusedHistoryRef.current = undefined;
    setFocusedHistory(undefined);
    setFocusedEntryId(undefined);
    sessionSnapshotRef.current = undefined;
    applySnapshot(latest, "once");
    return latest;
  };

  const openConversation = async (sessionId: string) => {
    if (session?.id === sessionId && !focusedHistoryRef.current) return;
    invalidateSessionInteractions("open-session");
    const ticket = interactionCoordinator.begin("session-transition", { sessionId, source: "sidebar" });
    stopSpeech();
    pendingUserMessageRef.current = undefined;
    setError("");
    setRunNotice("");
    setEditingEntryId(undefined);
    setMediaSummaries({});
    setPreviewImage(undefined);
    openingSessionRef.current = sessionId;
    setOpeningSessionId(sessionId);
    try {
      focusedHistoryRef.current = undefined;
      setFocusedHistory(undefined);
      setFocusedEntryId(undefined);
      sessionSnapshotRef.current = undefined;
      const opened = await api.openSession(sessionId);
      if (!guardInteraction(ticket, "open-session-response")) return;
      applySnapshot(opened, "once");
      closeSidebar();
      interactionCoordinator.finish(ticket, "applied", { lastEventId: opened.lastEventId });
    } catch (reason) {
      if (!guardInteraction(ticket, "open-session-error")) return;
      interactionCoordinator.finish(ticket, "failed");
      await reportFailure(reason, "打开会话");
    } finally {
      if (pageMountedRef.current && interactionCoordinator.isCurrent(ticket)) {
        openingSessionRef.current = undefined;
        setOpeningSessionId(undefined);
      }
    }
  };

  /** 打开搜索命中的 Session，并用稳定 entry ID 切换到目标历史窗口。 */
  const openSearchHit = async (hit: SessionTextSearchHit): Promise<void> => {
    invalidateSessionInteractions("open-search-hit");
    const ticket = interactionCoordinator.begin("session-transition", { sessionId: hit.sessionId, source: "search" });
    stopSpeech();
    pendingUserMessageRef.current = undefined;
    setError("");
    setEditingEntryId(undefined);
    setMediaSummaries({});
    setPreviewImage(undefined);
    openingSessionRef.current = hit.sessionId;
    setOpeningSessionId(hit.sessionId);
    try {
      const opened = await api.openSession(hit.sessionId);
      if (!guardInteraction(ticket, "search-session-response")) return;
      const branchToken = opened.history?.branchToken;
      if (!branchToken) throw new Error("SESSION_BRANCH_CHANGED");
      const target = await api.loadSessionHistoryTarget(hit.sessionId, hit.entryId, branchToken);
      if (!guardInteraction(ticket, "search-history-response")) return;
      if (target.sessionId !== hit.sessionId || target.targetEntryId !== hit.entryId || target.history.branchToken !== branchToken) {
        throw new Error("SESSION_ENTRY_NOT_FOUND");
      }
      pauseFollowing();
      const focusedSnapshot: SessionSnapshot = { ...opened, messages: target.messages, history: target.history };
      const nextFocus = { sessionId: hit.sessionId, entryId: hit.entryId };
      focusedHistoryRef.current = nextFocus;
      setFocusedHistory(nextFocus);
      setFocusedEntryId(hit.entryId);
      sessionSnapshotRef.current = focusedSnapshot;
      setSession(focusedSnapshot);
      applySnapshotRuntime(opened);
      applyAuthoritativeRun(opened.run);
      setTimeline(parsePiHistory(target.messages, false));
      if (!await focusSessionEntry(hit.entryId)) throw new Error("SESSION_ENTRY_NOT_FOUND");
      if (!guardInteraction(ticket, "search-focus-complete")) return;
      closeSidebar();
      setSessionSearchOpen(false);
      interactionCoordinator.finish(ticket, "applied", { entryId: hit.entryId });
    } catch {
      if (!guardInteraction(ticket, "search-session-error")) return;
      interactionCoordinator.finish(ticket, "failed");
      throw new Error("记录已变化，请重新搜索");
    } finally {
      if (pageMountedRef.current && interactionCoordinator.isCurrent(ticket)) {
        openingSessionRef.current = undefined;
        setOpeningSessionId(undefined);
      }
    }
  };

  const returnToLatest = async () => {
    const targetSessionId = focusedHistoryRef.current?.sessionId;
    if (!targetSessionId || openingSessionRef.current) return;
    invalidateSessionInteractions("return-latest");
    const ticket = interactionCoordinator.begin("session-transition", { sessionId: targetSessionId, source: "return-latest" });
    openingSessionRef.current = targetSessionId;
    setOpeningSessionId(targetSessionId);
    try {
      const restored = await restoreLatestConversation(targetSessionId, ticket);
      if (restored) interactionCoordinator.finish(ticket, "applied", { lastEventId: restored.lastEventId });
    } catch (reason) {
      if (!guardInteraction(ticket, "return-latest-error")) return;
      interactionCoordinator.finish(ticket, "failed");
      await reportFailure(reason, "返回最新消息");
    } finally {
      if (pageMountedRef.current && interactionCoordinator.isCurrent(ticket)) {
        openingSessionRef.current = undefined;
        setOpeningSessionId(undefined);
      }
    }
  };

  /**
   * 刷新当前 Agent 的会话摘要；仅在当前会话被移除时切换右侧聊天内容。
   */
  const refreshSessions = async () => {
    const agentId = selectedAgentIdRef.current;
    if (!agentId || refreshingSessions || openingSessionRef.current) return;
    setRefreshingSessions(true);
    try {
      const nextSessions = await loadSessionSummaries(agentId, false, "manual-refresh");
      if (!nextSessions) return;
      setSessions(nextSessions);
      const activeSessionId = sessionIdRef.current;
      if (activeSessionId && !nextSessions.some((item) => item.id === activeSessionId)) {
        if (nextSessions[0]) {
          await openConversation(nextSessions[0].id);
        } else {
          enterDraft();
        }
      }
    } catch (reason) {
      await reportFailure(reason, "刷新会话列表");
    } finally {
      setRefreshingSessions(false);
    }
  };

  const renameConversation = async (sessionId: string, name: string) => {
    try {
      await api.renameSession(sessionId, name);
      setSessions((current) => current.map((item) => item.id === sessionId ? { ...item, name } : item));
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "重命名会话");
    }
  };

  /** 持久化置顶状态，并按置顶分区和最近更新时间立即重排侧栏。 */
  const changeConversationPinned = async (sessionId: string, pinned: boolean): Promise<boolean> => {
    setError("");
    const outcome = await runApiTask(
      () => pinned ? api.pinSession(sessionId) : api.unpinSession(sessionId),
      { operation: pinned ? "置顶会话" : "取消置顶会话", expected: chatExpected(setError) },
    );
    if (outcome.status !== "success") return false;
    setSessions((current) => sortSessionsPinnedFirst(current.map((item) => (
      item.id === sessionId ? { ...item, pinned } : item
    ))));
    sessionSyncRef.current?.notify();
    return true;
  };

  const archiveConversation = async (sessionId: string) => {
    try {
      await api.archiveSession(sessionId);
      setSessions((current) => current.filter((item) => item.id !== sessionId));
      leaveRemovedSessions(new Set([sessionId]));
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "归档会话");
    }
  };

  const deleteConversation = async (sessionId: string, archived = false, confirmBoundTasks = false) => {
    const suspendingCurrentStream = !openingSessionRef.current && sessionIdRef.current === sessionId;
    if (suspendingCurrentStream) {
      // 服务端会在 DELETE 响应前终止 SSE，先撤销流归属，避免把预期关闭误报为网络中断。
      flushSync(() => setSuspendedSessionStreamId(sessionId));
      stream.close();
    }
    try {
      await api.deleteSession(sessionId, confirmBoundTasks);
      if (archived) {
        setArchivedSessions((current) => current.filter((item) => item.id !== sessionId));
      } else {
        setSessions((current) => current.filter((item) => item.id !== sessionId));
      }
      leaveRemovedSessions(new Set([sessionId]));
      if (suspendingCurrentStream) {
        setSuspendedSessionStreamId((current) => current === sessionId ? undefined : current);
      }
      sessionSyncRef.current?.notify();
    } catch (reason) {
      if (suspendingCurrentStream) {
        setSuspendedSessionStreamId((current) => current === sessionId ? undefined : current);
      }
      await reportFailure(reason, "删除会话");
    }
  };

  /** 从会话菜单进入多选，触发会话可操作时默认选中。 */
  const enterSessionSelection = (sessionId: string) => {
    const selectable = !(streaming && session?.id === sessionId);
    setSessionSelectionMode(true);
    setSelectedSessionIds(selectable ? [sessionId] : []);
    setSessionBulkPreview(undefined);
  };

  const toggleSessionSelection = (sessionId: string) => {
    if (streaming && session?.id === sessionId) return;
    setSelectedSessionIds((current) => current.includes(sessionId)
      ? current.filter((id) => id !== sessionId)
      : [...current, sessionId]);
  };

  /** 请求服务端稳定预览后才展示批量操作二次确认。 */
  const previewSessionBulk = async (action: SessionBulkAction, target?: SessionBulkTarget) => {
    const resolvedTarget = target ?? { mode: "selected", sessionIds: selectedSessionIds };
    if ((resolvedTarget.mode === "selected" && resolvedTarget.sessionIds.length === 0) || sessionBulkBusy) return;
    setSessionBulkBusy(true);
    setSessionBulkPreview(undefined);
    setError("");
    try {
      setSessionBulkPreview(await api.previewSessionBulk(action, resolvedTarget));
    } catch (reason) {
      await reportFailure(reason, "预览会话批量操作");
    } finally {
      setSessionBulkBusy(false);
    }
  };

  /** 使用预览指纹提交原子批量操作，并同步刷新本地会话列表。 */
  const executeSessionBulk = async () => {
    const preview = sessionBulkPreview;
    if (!preview || sessionBulkBusy) return;
    setSessionBulkBusy(true);
    setError("");
    try {
      const archivedSessionIds = new Set(archivedSessions.map((item) => item.id));
      await api.executeSessionBulk(preview.action, preview.target, preview.fingerprint);
      if (preview.target.mode === "all_archived") {
        if (!selectedAgentId) return;
        const [normal, archived] = await Promise.all([
          loadSessionSummaries(selectedAgentId, false, "bulk-operation"),
          loadSessionSummaries(selectedAgentId, true, "bulk-operation"),
        ]);
        if (!normal || !archived) return;
        setSessions(normal);
        setArchivedSessions(archived);
        setSessionBulkPreview(undefined);
        sessionSyncRef.current?.notify();
        if (preview.action === "delete") leaveRemovedSessions(archivedSessionIds);
        return;
      }
      const removedIds = new Set(preview.target.sessionIds);
      setSessions((current) => current.filter((item) => !removedIds.has(item.id)));
      sessionSyncRef.current?.notify();
      const currentSessionWasRemoved = Boolean(sessionIdRef.current && removedIds.has(sessionIdRef.current));
      leaveRemovedSessions(removedIds);
      if (!currentSessionWasRemoved) {
        cancelSessionSelection();
      }
    } catch (reason) {
      setSessionBulkPreview(undefined);
      await reportFailure(reason, "执行会话批量操作");
    } finally {
      setSessionBulkBusy(false);
    }
  };

  const showArchivedSessions = async () => {
    setArchiveDialogOpen(true);
    try {
      if (!selectedAgentId) return;
      const result = await loadSessionSummaries(selectedAgentId, true, "archive-dialog");
      if (result) setArchivedSessions(result);
    } catch (reason) {
      await reportFailure(reason, "加载归档会话");
    }
  };

  const restoreConversation = async (sessionId: string) => {
    try {
      await api.unarchiveSession(sessionId);
      if (!selectedAgentId) return;
      const [normal, archived] = await Promise.all([
        loadSessionSummaries(selectedAgentId, false, "restore-session"),
        loadSessionSummaries(selectedAgentId, true, "restore-session"),
      ]);
      if (!normal || !archived) return;
      setSessions(normal);
      setArchivedSessions(archived);
      sessionSyncRef.current?.notify();
    } catch (reason) {
      await reportFailure(reason, "恢复会话");
    }
  };

  const openArchivedConversation = async (sessionId: string) => {
    await openConversation(sessionId);
    setArchiveDialogOpen(false);
  };

  const send = async () => {
    const text = draft.trim();
    const files = attachmentItems.flatMap((item) => item.status === "uploaded" && item.workspaceFile ? [item.workspaceFile] : []);
    const references = mergeMessageReferences(draftReferences, files);
    const attachmentBusy = attachmentItems.some((item) => item.status !== "uploaded");
    if ((!text && files.length === 0 && references.length === 0)
      || streaming
      || runtimeChanging
      || attachmentBusy
      || !selectedAgentId
      || !selectedModel) {
      return;
    }
    const ticket = interactionCoordinator.begin("message-send", {
      sessionId: session?.id ?? "draft",
      agentId: selectedAgentId,
      branch: Boolean(editingEntryId),
    });
    const branchEntryId = editingEntryId;
    const previousAttachmentItems = attachmentItems;
    let requestSessionId: string | undefined;
    try {
      stopSpeech();
      let baseSession = session;
      let baseTimeline = timeline;
      if (focusedHistoryRef.current) {
        baseSession = await restoreLatestConversation(focusedHistoryRef.current.sessionId, ticket);
        if (!baseSession) return;
        baseTimeline = parsePiHistory(
          baseSession.messages,
          baseSession.run?.status === "queued" || baseSession.run?.status === "running",
        );
      }
      // 分支请求尚未返回前即退出编辑态，避免来源消息持续显示“编辑中”。
      if (branchEntryId) setEditingEntryId(undefined);
      const wasDraft = !baseSession;
      const activeSession = baseSession ?? await createConversation(selectedAgentId, ticket);
      if (!activeSession || !guardInteraction(ticket, "session-ready")) return;
      requestSessionId = activeSession.id;
      if (wasDraft && !isSameModel(activeSession.model, selectedModel)) {
        await api.setModel(activeSession.id, selectedModel.provider, selectedModel.id);
        if (!guardInteraction(ticket, "draft-model-response")) return;
        activeSession.model = selectedModel;
      }
      if (wasDraft && activeSession.thinkingLevel !== selectedThinkingLevel) {
        await api.setThinkingLevel(activeSession.id, selectedThinkingLevel);
        if (!guardInteraction(ticket, "draft-thinking-response")) return;
        activeSession.thinkingLevel = selectedThinkingLevel;
      }
      await stream.ensureOpen();
      if (!guardInteraction(ticket, "stream-ready")) return;
      setDraft("");
      setDraftReferences([]);
      setAttachmentItems([]);
      setError("");
      setRunNotice("");
      setActiveRun({
        runId: `pending-${crypto.randomUUID()}`,
        sessionId: activeSession.id,
        status: "queued",
        startedAt: new Date().toISOString(),
      });
      resumeFollowing();
      const pendingEntry: UserEntry = {
        id: crypto.randomUUID(),
        type: "user",
        text,
        files,
        references,
      };
      const sendingAgentId = activeSession.agentId ?? selectedAgentId;
      const sendingAgent = agents.find((item) => item.profile.id === sendingAgentId);
      autoSpeechEligibilityRef.current = sendingAgent?.profile.ttsProfileId
        && sendingAgent.profile.ttsAutoPlay === true
        ? {
          sessionId: activeSession.id,
          previousTurnId: findLastAgentTurnId(baseTimeline),
        }
        : undefined;
      pendingUserMessageRef.current = createPendingUserMessage(
        activeSession.id,
        pendingEntry,
        baseTimeline,
        branchEntryId,
      );
      setTimeline((current) => reduceTimeline(reduceTimeline(current, {
          type: "user_message",
          id: pendingEntry.id,
          text,
          files,
          references,
        }), { type: "generation_started" }));
      if (wasDraft) {
        setSessions((current) => sortSessionsPinnedFirst([{
          id: activeSession.id,
          agentId: activeSession.agentId,
          firstMessage: text || files[0]?.name || "新对话",
          modified: new Date().toISOString(),
          messageCount: 1,
          pinned: false,
        }, ...current.filter((item) => item.id !== activeSession.id)]));
      }
      if (branchEntryId) {
        const runRevision = streamRunRevisionRef.current;
        const result = await api.sendBranchMessage(activeSession.id, branchEntryId, text, files.map((file) => file.path), draftReferences);
        if (!guardInteraction(ticket, "branch-send-response") || sessionIdRef.current !== activeSession.id) return;
        if (streamRunRevisionRef.current !== runRevision) {
          await refreshSessionProjection(activeSession.id, "once");
          return;
        }
        // 分支发送立刻以服务端导航快照替换旧路径，同时保留本地待发送气泡。
        applySnapshot(result.snapshot, "once");
        setActiveRun(result.run);
      } else {
        const runRevision = streamRunRevisionRef.current;
        const run = await api.sendMessage(activeSession.id, text, files.map((file) => file.path), draftReferences);
        if (!guardInteraction(ticket, "send-response")) return;
        if (sessionIdRef.current === activeSession.id && streamRunRevisionRef.current === runRevision) {
          setActiveRun(run);
        }
      }
      if (activeSession.pendingQuestion) {
        questionDraft.clear();
        const next = { ...activeSession, pendingQuestion: undefined };
        sessionSnapshotRef.current = next;
        setSession(next);
      }
      interactionCoordinator.finish(ticket, "applied", { sessionId: activeSession.id });
    } catch (reason) {
      if (!guardInteraction(ticket, "send-error")) return;
      interactionCoordinator.finish(ticket, "failed", { sessionId: requestSessionId });
      autoSpeechEligibilityRef.current = undefined;
      const stillCurrentSession = !requestSessionId || sessionIdRef.current === requestSessionId;
      if (!stillCurrentSession) return;
      if (!requestSessionId || pendingUserMessageRef.current?.sessionId === requestSessionId) {
        pendingUserMessageRef.current = undefined;
      }
      let recoveredActiveRun = false;
      if (requestSessionId && sessionIdRef.current === requestSessionId) {
        try {
          const recovered = await refreshSessionProjection(requestSessionId);
          recoveredActiveRun = recovered?.run?.status === "queued" || recovered?.run?.status === "running";
        } catch {
          // 请求结果不确定时保留当前状态，等待 SSE 或后续重连恢复，避免误报空闲。
        }
      }
      if (!recoveredActiveRun) {
        setTimeline((current) => reduceTimeline(current, { type: "generation_finished", outcome: "error" }));
        setDraft(text);
        setDraftReferences(draftReferences);
        setAttachmentItems(previousAttachmentItems);
        if (branchEntryId) setEditingEntryId(branchEntryId);
      }
      await reportFailure(reason, branchEntryId ? "编辑并重新发送消息" : "发送消息");
    }
  };

  /** 提交当前浏览器草稿并把返回的 Run 设为活动运行。 */
  const submitQuestionAnswers = async (answers: SubmittedQuestionAnswer[]) => {
    if (!session || !pendingQuestion || questionSubmitting) return;
    const submittedSessionId = session.id;
    const submittedQuestionId = pendingQuestion.id;
    const submittedBranchToken = session.history?.branchToken;
    const ticket = interactionCoordinator.begin("question-submission", {
      sessionId: submittedSessionId,
      questionId: submittedQuestionId,
    });
    setQuestionSubmitting(true);
    setError("");
    setRunNotice("");
    try {
      await stream.ensureOpen();
      const runRevision = streamRunRevisionRef.current;
      const result = await api.submitQuestionAnswers(submittedSessionId, submittedQuestionId, {
        version: pendingQuestion.version,
        answers,
      });
      if (!guardInteraction(ticket, "question-response") || sessionIdRef.current !== submittedSessionId) return;
      // Run 启动快照可能先清除待答状态；成功响应仍需立即写入权威回答卡片。
      pendingQuestionResponseRef.current = submittedBranchToken
        ? createPendingQuestionResponse(submittedSessionId, submittedBranchToken, result.resolution)
        : undefined;
      setTimeline((current) => reduceTimeline(current, {
        type: "question_resolved",
        resolution: result.resolution,
      }));
      questionDraft.clear();
      setSession((current) => {
        if (!current || current.id !== submittedSessionId || current.pendingQuestion?.id !== submittedQuestionId) return current;
        const next = { ...current, pendingQuestion: undefined };
        sessionSnapshotRef.current = next;
        return next;
      });
      // Run 事件比 POST 响应更权威；期间若已收到开始或终态事件，不再用迟到响应覆盖。
      if (streamRunRevisionRef.current === runRevision) setActiveRun(result.run);
      resumeFollowing();
      interactionCoordinator.finish(ticket, "applied", { sessionId: submittedSessionId });
    } catch (reason) {
      if (guardInteraction(ticket, "question-error") && sessionIdRef.current === submittedSessionId) {
        interactionCoordinator.finish(ticket, "failed", { sessionId: submittedSessionId });
        await reportFailure(reason, "提交提问回答");
      }
    } finally {
      if (pageMountedRef.current && interactionCoordinator.isCurrent(ticket)) setQuestionSubmitting(false);
    }
  };

  const uploadFiles = async (files: File[]) => {
    const localItems = files.map((file): AttachmentUploadItem => ({
      localId: crypto.randomUUID(),
      file,
      status: "uploading",
    }));
    setError("");
    setAttachmentItems((current) => [...current, ...localItems]);
    try {
      const uploadAgentId = selectedAgentId;
      if (!uploadAgentId) throw new Error("请先创建并选择 Agent");
      const result = await api.uploadAttachments(uploadAgentId, files);
      if (selectedAgentIdRef.current !== uploadAgentId) return;
      setAttachmentItems((current) => current.map((item) => {
        const index = localItems.findIndex((local) => local.localId === item.localId);
        return index >= 0 ? { ...item, status: "uploaded", workspaceFile: result.files[index] } : item;
      }));
    } catch (reason) {
      if (selectedAgentIdRef.current !== selectedAgentId) return;
      const outcome = await reportFailure(reason, "上传聊天附件");
      const message = outcome.status === "handled" && reason instanceof Error
        ? reason.message
        : "附件上传失败，请检查文件后重试。";
      setAttachmentItems((current) => current.map((item) => localItems.some((local) => local.localId === item.localId)
        ? { ...item, status: "error", error: message }
        : item));
      setError(message);
    }
  };

  /** 让文件选择、粘贴和拖放共享相同的数量与大小限制。 */
  const queueAttachmentFiles = (files: File[]) => {
    const validationError = validateAttachmentSelection(attachmentItems.length, files);
    if (validationError) {
      setError(validationError);
      return;
    }
    void uploadFiles(files);
  };

  const abort = async () => {
    if (!session) return;
    const targetSessionId = session.id;
    stopSpeech();
    try {
      await api.abort(targetSessionId);
      await refreshSessionProjection(targetSessionId);
    } catch (reason) {
      await reportFailure(reason, "停止消息生成");
    }
  };

  const activeAgentId = session?.agentId ?? selectedAgentId;
  const activeAgent = agents.find((item) => item.profile.id === activeAgentId);
  const reportMediaDeleteError = useCallback((confirmationError: { code: string; message: string }) => {
    if (session?.id) setMediaDeleteError({ sessionId: session.id, error: confirmationError });
  }, [session?.id]);
  const confirmationErrorEntry: AgentTurn[] = mediaDeleteError && mediaDeleteError.sessionId === session?.id && !focusedHistory
    ? [{ id: "media-delete-confirmation-error", type: "agent",
        blocks: [{ id: "media-delete-error", type: "error", ...mediaDeleteError.error }] }]
    : [];
  const noAvailableAgent = agents.length === 0;
  useEffect(() => {
    setWorkspaceLocationRequest(undefined);
    setWorkspaceMessage("");
    setPreviewFilePath(undefined);
  }, [activeAgentId]);
  const activateDataFileLink = useCallback((href: string): boolean => {
    const intent = classifyDataFileLink(href);
    if (intent.kind === "passthrough") return false;
    closeSidebar();
    setResourcesOpen(false);
    setPreviewFilePath(intent.path);
    return true;
  }, []);

  useEffect(() => {
    const profile = activeAgent?.profile;
    const eligibility = autoSpeechEligibilityRef.current;
    const turn = [...timeline].reverse().find((entry) => entry.type === "agent");
    if (!profile?.ttsProfileId
      || profile.ttsAutoPlay !== true
      || !eligibility
      || eligibility.sessionId !== session?.id
      || !turn
      || !activeAgentId) {
      return;
    }
    if (!eligibility.turnId) {
      if (turn.id === eligibility.previousTurnId) {
        return;
      }
      eligibility.turnId = turn.id;
    }
    if (eligibility.turnId !== turn.id) {
      return;
    }
    const text = agentTurnSpeechText(turn);
    if (!text) {
      return;
    }
    const controller = ensureSpeechController(activeAgentId);
    if (profile.ttsStreamPlayback) {
      controller.start(turn.id);
      controller.update(turn.id, text, !streaming);
      if (!streaming) {
        autoSpeechEligibilityRef.current = undefined;
      }
      return;
    }
    if (streaming) {
      return;
    }
    controller.start(turn.id);
    controller.update(turn.id, text, true);
    autoSpeechEligibilityRef.current = undefined;
  }, [activeAgent, activeAgentId, ensureSpeechController, session?.id, streaming, timeline]);

  /** 切换当前消息的手动朗读状态。 */
  const toggleSpeech = (turn: AgentTurn) => {
    if (!activeAgentId || !activeAgent?.profile.ttsProfileId) {
      return;
    }
    if (speechState.messageId === turn.id) {
      stopSpeech();
      return;
    }
    autoSpeechEligibilityRef.current = undefined;
    const text = agentTurnSpeechText(turn);
    if (prepareSpeechSegments(text, true).length === 0) {
      setError("该消息没有可朗读内容。");
      return;
    }
    setError("");
    const controller = ensureSpeechController(activeAgentId);
    controller.start(turn.id);
    controller.update(turn.id, text, true);
  };

  /** 将 Pi 历史用户消息还原到现有编辑器，协议文本由服务端在返回前拆解。 */
  const editHistory = async (entryId: string) => {
    if (!session || streaming || isOpeningSession) return;
    const targetSessionId = session.id;
    const ticket = interactionCoordinator.begin("history-edit", { sessionId: targetSessionId, entryId });
    try {
      stopSpeech();
      const result = await api.editSessionBranch(targetSessionId, entryId);
      if (!guardInteraction(ticket, "history-edit-response") || sessionIdRef.current !== targetSessionId) return;
      setEditingEntryId(entryId);
      setDraft(result.draft.text);
      setDraftReferences(result.draft.references);
      setAttachmentItems(result.draft.filePaths.map((path) => {
        const missing = result.draft.missingFilePaths.includes(path);
        const name = path.split("/").at(-1) ?? path;
        return {
          localId: `history-${path}`,
          file: new File([], name),
          status: missing ? "missing" as const : "uploaded" as const,
          ...(missing ? { error: `已失效：${path}` } : { workspaceFile: { path, name, mediaType: "application/octet-stream", size: 0, modifiedAt: "" } }),
        };
      }));
      setError(result.draft.missingFilePaths.length > 0 ? `历史附件已失效：${result.draft.missingFilePaths.join("、")}` : "");
      interactionCoordinator.finish(ticket, "applied", { sessionId: targetSessionId, entryId });
    } catch (reason) {
      if (!guardInteraction(ticket, "history-edit-error") || sessionIdRef.current !== targetSessionId) return;
      interactionCoordinator.finish(ticket, "failed", { sessionId: targetSessionId, entryId });
      await reportFailure(reason, "编辑历史消息");
    }
  };

  /** 退出历史消息编辑态，避免回填草稿被误认为一条普通新消息。 */
  const cancelEditing = () => {
    setEditingEntryId(undefined);
    setDraft("");
    setDraftReferences([]);
    setAttachmentItems([]);
    setError("");
  };

  /** 重新提交 Pi 保存的原始用户 prompt，创建新的同级分支。 */
  const regenerate = async (entryId: string) => {
    if (!session || streaming || isOpeningSession) return;
    const targetSessionId = session.id;
    const ticket = interactionCoordinator.begin("branch-navigation", {
      sessionId: targetSessionId,
      entryId,
      action: "regenerate",
    });
    const sourceEntry = timeline.find((entry): entry is UserEntry => (
      entry.type === "user" && entry.piEntryId === entryId
    ));
    if (!sourceEntry) {
      setError("找不到重新生成所对应的用户消息。");
      return;
    }
    const pendingEntry: UserEntry = {
      id: crypto.randomUUID(),
      type: "user",
      text: sourceEntry.text,
      files: sourceEntry.files,
      references: sourceEntry.references,
    };
    pendingUserMessageRef.current = createPendingUserMessage(
      targetSessionId,
      pendingEntry,
      timeline,
      entryId,
    );
    try {
      stopSpeech();
      const runRevision = streamRunRevisionRef.current;
      const result = await api.regenerateSessionBranch(targetSessionId, entryId);
      if (!guardInteraction(ticket, "regenerate-response") || sessionIdRef.current !== targetSessionId) return;
      if (streamRunRevisionRef.current !== runRevision) {
        await refreshSessionProjection(targetSessionId, "once");
        return;
      }
      applySnapshot(result.snapshot, "once");
      setActiveRun(result.run);
      setError("");
      interactionCoordinator.finish(ticket, "applied", { sessionId: targetSessionId, entryId });
    } catch (reason) {
      if (!guardInteraction(ticket, "regenerate-error") || sessionIdRef.current !== targetSessionId) return;
      const pending = pendingUserMessageRef.current;
      if (pending?.sessionId === targetSessionId && pending.entry.id === pendingEntry.id) {
        pendingUserMessageRef.current = undefined;
      }
      interactionCoordinator.finish(ticket, "failed", { sessionId: targetSessionId, entryId });
      await reportFailure(reason, "重新生成回答");
    }
  };

  /** 切换到历史分支的可渲染叶节点，不触发编辑草稿回填。 */
  const navigateHistory = async (entryId: string) => {
    if (!session || streaming || isOpeningSession) return;
    const targetSessionId = session.id;
    const ticket = interactionCoordinator.begin("branch-navigation", {
      sessionId: targetSessionId,
      entryId,
      action: "navigate",
    });
    try {
      stopSpeech();
      const snapshot = await api.navigateSessionBranch(targetSessionId, entryId);
      if (!guardInteraction(ticket, "navigate-response") || sessionIdRef.current !== targetSessionId) return;
      setEditingEntryId(undefined);
      setDraft("");
      setDraftReferences([]);
      setAttachmentItems([]);
      setError("");
      applySnapshot(snapshot, "once");
      interactionCoordinator.finish(ticket, "applied", { sessionId: targetSessionId, entryId });
    } catch (reason) {
      if (!guardInteraction(ticket, "navigate-error") || sessionIdRef.current !== targetSessionId) return;
      interactionCoordinator.finish(ticket, "failed", { sessionId: targetSessionId, entryId });
      await reportFailure(reason, "切换会话分支");
    }
  };

  const selectAgent = async (agentId: string) => {
    if (streaming || isOpeningSession) return;
    const ticket = interactionCoordinator.begin("agent-selection", { agentId, source: "menu" });
    const nextAgent = agents.find((item) => item.profile.id === agentId);
    cacheSelectedAgentId(agentId);
    selectedAgentIdRef.current = agentId;
    setSelectedAgentId(agentId);
    resetToDraft(nextAgent);
    try {
      const result = await loadSessionSummaries(agentId, false, "agent-selection");
      if (!guardInteraction(ticket, "agent-sessions-response")) return;
      if (!result) return;
      setSessions(result);
      interactionCoordinator.finish(ticket, "applied", { agentId });
    } catch (reason) {
      if (guardInteraction(ticket, "agent-selection-error")) {
        interactionCoordinator.finish(ticket, "failed", { agentId });
        await reportFailure(reason, "切换 Agent");
      }
    }
  };

  const saveProfileName = async () => {
    if (!profileRevision || profileSaving) return;
    setProfileSaving(true);
    try {
      const document = await api.updateProfile(profileRevision, profileDisplayName);
      setProfileRevision(document.revision);
      setProfileIdentity(toIdentityPreview(document.profile));
      setProfileDisplayName(document.profile.displayName);
    } catch (reason) {
      await reportFailure(reason, "保存个人资料");
    } finally {
      setProfileSaving(false);
    }
  };

  const selectProfileAvatar = (file: File | undefined) => {
    if (!file) return;
    const validation = validateAvatarFile(file);
    setProfileAvatarError(validation ?? "");
    if (!validation) setProfileAvatarFile(file);
  };

  const uploadProfileAvatar = async (crop: AvatarCropArea) => {
    if (!profileAvatarFile || !profileRevision || profileSaving) return;
    setProfileSaving(true);
    const result = await runApiTask(
      () => api.uploadProfileAvatar(profileRevision, profileAvatarFile, crop),
      { operation: "上传个人头像", expected: avatarExpected(setProfileAvatarError) },
    );
    if (result.status === "success") {
      const document = result.data;
      setProfileRevision(document.revision);
      setProfileIdentity(toIdentityPreview(document.profile));
      setProfileAvatarFile(undefined);
      setProfileAvatarError("");
    }
    setProfileSaving(false);
  };

  const userNavigationItems = timeline.flatMap((entry) => entry.type === "user" ? [{
    id: entry.id,
    summary: summarizePrompt(entry.text, entry.files.map((file) => file.path)),
    targetId: userMessageDomId(entry.id),
  }] : []);
  const activeAgentEntryId = [...timeline].reverse().find((entry) => entry.type === "agent")?.id;

  return (
    <main className="chat-shell live-chat-shell" {...workspaceSwipe.handlers}>
      <ChatSidebar
        open={sidebarOpen}
        sessions={sessions}
        activeSessionId={session?.id}
        openingSessionId={openingSessionId}
        scrolling={sessionNavScrolling}
        noAvailableAgent={noAvailableAgent}
        streaming={streaming}
        refreshing={refreshingSessions}
        profileIdentity={profileIdentity}
        actionsOpenRequest={sessionActionsOpenRequest}
        selectionMode={sessionSelectionMode}
        selectedSessionIds={selectedSessionIds}
        bulkBusy={sessionBulkBusy}
        swiping={workspaceSwipe.sessionTranslatePercent !== undefined}
        swipeTranslatePercent={workspaceSwipe.sessionTranslatePercent}
        onClose={closeSidebar}
        onEnterDraft={enterDraft}
        onRefresh={() => void refreshSessions()}
        onSearch={() => setSessionSearchOpen(true)}
        onScroll={showSessionNavScrollbar}
        onPointerDown={startSessionLongPress}
        onPointerEnd={clearSessionLongPress}
        shouldSuppressOpen={(sessionId) => {
          if (suppressSessionOpenRef.current !== sessionId) return false;
          suppressSessionOpenRef.current = undefined;
          return true;
        }}
        onOpen={(sessionId) => void openConversation(sessionId)}
        onRename={(sessionId, name) => void renameConversation(sessionId, name)}
        onPinChange={changeConversationPinned}
        onArchive={(sessionId) => void archiveConversation(sessionId)}
        onDelete={(sessionId, confirmBoundTasks) => void deleteConversation(sessionId, false, confirmBoundTasks)}
        onEnterSelection={enterSessionSelection}
        onToggleSelection={toggleSessionSelection}
        onCancelSelection={cancelSessionSelection}
        onBulkArchive={() => void previewSessionBulk("archive")}
        onBulkDelete={() => void previewSessionBulk("delete")}
        onShowArchived={() => void showArchivedSessions()}
        onEditProfile={() => setProfileOpen(true)}
      />

      <section className="chat-workspace">
        <header className="chat-header live-chat-header">
          <div className="chat-header__left">
            <button type="button" className="icon-button mobile-menu" aria-label="打开会话历史" onClick={() => setSidebarOpen(true)}><Menu size={19} /></button>
            <button type="button" className="chat-workbench-switcher" aria-label="打开工作台导航" onClick={() => {
              closeSidebar();
              window.dispatchEvent(new Event(WORKBENCH_NAVIGATION_TOGGLE_EVENT));
            }}><span>工作台</span><ChevronDown size={14} aria-hidden="true" /></button>
            <div className="chat-title"><strong>{session ? "Agent 对话" : "新对话"}</strong><span>pi SDK · 实时连接</span></div>
          </div>
          <div className="chat-header__actions">
            <AgentModelMenu
              agents={agents}
              selectedAgentId={activeAgentId}
              disabled={streaming || isOpeningSession}
              onSelectAgent={(agentId) => void selectAgent(agentId)}
            />
            <button type="button" className="icon-button quick-workspace-open-button" aria-label="打开快捷资源管理" title="快捷资源管理" disabled={!activeAgentId} onClick={(event) => { workspaceTriggerRef.current = event.currentTarget; setWorkspaceMessage(""); openDrawer("resources"); }}><FolderOpen size={18} aria-hidden="true" /></button>
            <button
              type="button"
              className="icon-button chat-new-session-button"
              aria-label="新建会话"
              title="新建会话"
              disabled={noAvailableAgent || isOpeningSession}
              onClick={() => enterDraft()}
            >
              <MessageSquarePlus size={18} aria-hidden="true" />
            </button>
          </div>
        </header>

        <ConversationTimelineView
          timeline={confirmationErrorEntry.length ? [...timeline, ...confirmationErrorEntry] : timeline}
          theme={theme}
          activeAgent={activeAgent}
          activeAgentId={activeAgentId}
          noAvailableAgent={noAvailableAgent}
          streaming={streaming}
          opening={isOpeningSession}
          profileIdentity={profileIdentity}
          navigationItems={userNavigationItems}
          activeAgentEntryId={activeAgentEntryId}
          speechEnabled={Boolean(activeAgent?.profile.ttsProfileId)}
          activeSpeechMessageId={speechState.messageId}
          scrollRef={messageScrollRef}
          contentRef={messageContentRef}
          historyState={historyLoader.state}
          historySentinelRef={historyLoader.sentinelRef}
          newerHistoryState={historyLoader.newerState}
          newerHistorySentinelRef={historyLoader.newerSentinelRef}
          focusedHistory={Boolean(focusedHistory)}
          focusedEntryId={focusedEntryId}
          onRetryHistory={historyLoader.retry}
          onRetryNewerHistory={historyLoader.retryNewer}
          onReturnLatest={() => void returnToLatest()}
          onResolved={registerMediaSummary}
          onPreview={openImagePreview}
          onWorkspaceLink={activateDataFileLink}
          onCreateAgent={() => navigateTo({ page: "agents", onboarding: "create" })}
          onToggleSpeech={toggleSpeech}
          editingEntryId={editingEntryId}
          onEditHistory={(entryId) => void editHistory(entryId)}
          onNavigateHistory={(entryId) => void navigateHistory(entryId)}
          onRegenerate={(entryId) => void regenerate(entryId)}
        />

        <footer className="composer-dock">
          {composerError && <p className="live-chat-error" role="alert">{composerError}</p>}
          {pendingQuestion && !questionDraft.draft.collapsed ? <QuestionComposer
            pending={pendingQuestion}
            draft={questionDraft}
            submitting={questionSubmitting}
            error={composerError || undefined}
            onCollapse={() => questionDraft.setCollapsed(true)}
            onSubmit={(answers) => void submitQuestionAnswers(answers)}
          /> : <div className="composer">
            {pendingQuestion ? <button
              type="button"
              className="question-composer-resume"
              onClick={() => questionDraft.setCollapsed(false)}
            >继续回答 · {questionDraft.answeredCount}/{pendingQuestion.questions.length}</button> : null}
            <ReferenceComposer
              value={draft}
              references={draftReferences}
              disabled={noAvailableAgent || isOpeningSession}
              loadCatalog={() => selectedAgentId ? api.getComposerCatalog(selectedAgentId) : Promise.resolve({ skills: [], commands: [], knowledgeBases: [], workspaceEntries: [] })}
              onChange={setDraft}
              onReferencesChange={setDraftReferences}
              onFilesInput={queueAttachmentFiles}
              onSubmit={() => void send()}
              onCatalogError={setError}
              editingContext={editingEntryId ? <div className="composer-editing-context" role="status">
                <div className="composer-editing-context__heading"><PencilLine size={15} aria-hidden="true" /><span><strong>正在编辑历史消息</strong><small>发送后将创建新分支，原消息不会改动。</small></span></div>
                <p title={editingEntry?.text || draft}>{editingEntry?.text || draft || "历史消息"}</p>
                <button type="button" onClick={cancelEditing}>取消编辑</button>
              </div> : undefined}
              attachmentControl={<AttachmentPickerButton items={attachmentItems} disabled={streaming || isOpeningSession || !selectedAgentId} onFilesSelected={queueAttachmentFiles} onError={setError} />}
              railControls={<ComposerSessionControls
                models={models}
                selectedModel={selectedModel}
                thinkingLevel={selectedThinkingLevel}
                disabled={streaming || isOpeningSession || !selectedAgentId}
                onThinkingLevelChange={(thinkingLevel) => void changeThinkingLevel(thinkingLevel)}
                onModelChange={(model) => void changeModel(model)}
              />}
              attachmentContent={<AttachmentPicker items={attachmentItems} disabled={streaming || isOpeningSession || !selectedAgentId} showButton={false} onFilesSelected={queueAttachmentFiles} onRemove={(localId) => setAttachmentItems((current) => current.filter((item) => item.localId !== localId))} onError={setError} />}
              bottomControls={<div className="composer-actions">
                <ServerSpeechInputButton
                  disabled={noAvailableAgent || isOpeningSession}
                  onTranscript={(transcript) => setDraft((current) => appendSpeechTranscript(current, transcript))}
                  onError={setError}
                />
                <button type="button" disabled={isOpeningSession || (!streaming && (runtimeChanging || !selectedAgentId || !selectedModel))} className={streaming ? "send-button is-running" : "send-button"} aria-label={streaming ? "停止生成" : editingEntryId ? "创建分支并发送" : "发送消息"} title={streaming ? "停止生成" : editingEntryId ? "创建分支并发送" : "发送消息"} onClick={() => void (streaming ? abort() : send())}>{streaming ? <CircleStop size={18} /> : <Send size={18} />}</button>
              </div>}
            />
          </div>}
          <p>Agent 可以在容器权限范围内读取、修改文件和执行命令。</p>
        </footer>
      </section>
      <QuickWorkspaceDrawer
        open={resourcesOpen}
        agentId={activeAgentId}
        agentName={activeAgent?.profile.name}
        locationRequest={workspaceLocationRequest}
        message={workspaceMessage}
        swiping={workspaceSwipe.resourceTranslatePercent !== undefined}
        swipeTranslatePercent={workspaceSwipe.resourceTranslatePercent}
        onClose={closeResources}
      />
      <ArchivedSessionsDialog
        open={archiveDialogOpen}
        sessions={archivedSessions}
        busy={sessionBulkBusy}
        onClose={() => setArchiveDialogOpen(false)}
        onOpen={openArchivedConversation}
        onRestore={restoreConversation}
        onDelete={(sessionId) => deleteConversation(sessionId, true)}
        onRestoreAll={() => selectedAgentId && void previewSessionBulk("restore", { mode: "all_archived", agentId: selectedAgentId })}
        onDeleteAll={() => selectedAgentId && void previewSessionBulk("delete", { mode: "all_archived", agentId: selectedAgentId })}
      />
      <SessionSearchDialog
        open={sessionSearchOpen}
        agentId={selectedAgentId}
        onClose={() => setSessionSearchOpen(false)}
        onSelect={openSearchHit}
      />
      {sessionBulkPreview ? <SessionBulkConfirmationDialog
        preview={sessionBulkPreview}
        busy={sessionBulkBusy}
        onCancel={() => setSessionBulkPreview(undefined)}
        onConfirm={() => void executeSessionBulk()}
      /> : null}
      {session?.agentId && activeRun?.sessionId === session.id && !isOpeningSession
        && (activeAgent?.profile.allowedTools.includes("media_library_delete") || timeline.some((entry) => entry.type === "agent"
          && entry.blocks.some((block) => block.type === "tool" && block.name === "media_library_delete" && block.status === "running")))
        && <ChatMediaDeleteConfirmation key={activeRun.runId} agentId={session.agentId} sessionId={session.id}
          onError={reportMediaDeleteError} />}
      {previewImage ? <MediaLightbox item={previewImage} images={collectTimelineImages(timeline, mediaSummaries)} agentId={activeAgentId} onClose={() => setPreviewImage(undefined)} /> : null}
      {previewFilePath && activeAgentId ? <DataFilePreviewDialog agentId={activeAgentId} path={previewFilePath} onClose={() => setPreviewFilePath(undefined)} /> : null}
      <ProfileDialog
        open={profileOpen}
        displayName={profileDisplayName}
        saving={profileSaving}
        ready={Boolean(profileRevision)}
        avatarError={profileAvatarError}
        onClose={() => setProfileOpen(false)}
        onDisplayNameChange={setProfileDisplayName}
        onAvatarSelected={selectProfileAvatar}
        onSave={() => void saveProfileName()}
      />
      {profileAvatarFile ? <AvatarCropDialog
        file={profileAvatarFile}
        busy={profileSaving}
        error={profileAvatarError || undefined}
        onCancel={() => { setProfileAvatarFile(undefined); setProfileAvatarError(""); }}
        onReplace={selectProfileAvatar}
        onConfirm={(crop) => void uploadProfileAvatar(crop)}
      /> : null}
    </main>
  );
}

function toIdentityPreview(profile: { displayName: string; avatar?: { kind: "image"; revision: string } }): IdentityPreview {
  return { displayName: profile.displayName, avatarText: profile.displayName.trim().slice(0, 1).toUpperCase() || "A", avatar: profile.avatar };
}

/** 返回发送前最后一个 Agent turn，用于只绑定本次新回答。 */
function findLastAgentTurnId(entries: ConversationEntry[]): string | undefined {
  return entries.findLast((entry) => entry.type === "agent")?.id;
}

/**
 * 按当前会话的时间线顺序收集图片，并去除重复的同一路径附件。
 *
 * @param entries 当前会话消息时间线
 * @param summaries 已解析的附件元数据
 */
function collectTimelineImages(entries: ConversationEntry[], summaries: Record<string, WorkspaceFileSummary>): WorkspaceFileSummary[] {
  const paths = new Set<string>();
  const images: WorkspaceFileSummary[] = [];

  for (const entry of entries) {
    const files = entry.type === "user" ? entry.files : [];
    for (const file of files) {
      if (paths.has(file.path)) continue;
      paths.add(file.path);
      const summary = summaries[file.path];
      if (summary?.mediaType.startsWith("image/")) images.push(summary);
    }
  }
  return images;
}

/**
 * 乐观气泡中的上传附件也以文件引用展示，避免等待历史快照后才出现标签。
 */
function mergeMessageReferences(references: AgentReference[], files: WorkspaceFileSummary[]): AgentReference[] {
  const filePaths = new Set(references.flatMap((reference) => reference.type === "file" ? [reference.path] : []));
  return [
    ...references,
    ...files.flatMap((file) => {
      if (filePaths.has(file.path)) return [];
      filePaths.add(file.path);
      return [{ type: "file" as const, path: file.path, kind: "file" as const, name: file.name }];
    }),
  ];
}

/**
 * 读取仅在当前浏览器页面生命周期内有效的 Agent 选择。
 */
function readCachedAgentId(): string | undefined {
  try {
    return window.sessionStorage.getItem(SELECTED_AGENT_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * 保存当前页面会话中最后手动选择的 Agent。
 */
function cacheSelectedAgentId(agentId: string): void {
  try {
    window.sessionStorage.setItem(SELECTED_AGENT_STORAGE_KEY, agentId);
  } catch {
    // 浏览器禁用会话存储时保留当前页面的既有交互。
  }
}

/**
 * 清除已不存在 Agent 的缓存，避免后续页面持续命中无效值。
 */
function clearCachedAgentId(): void {
  try {
    window.sessionStorage.removeItem(SELECTED_AGENT_STORAGE_KEY);
  } catch {
    // 浏览器禁用会话存储时无需额外处理。
  }
}

function userMessageDomId(entryId: string): string {
  return `live-user-message-${entryId.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
}

function summarizePrompt(text: string, filePaths: string[] = []): string {
  const compact = text.replace(/\s+/g, " ").trim() || filePaths.join("、");
  return compact.length > 48 ? `${compact.slice(0, 48)}…` : compact;
}
