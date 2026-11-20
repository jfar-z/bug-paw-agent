import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import "../styles.css";
import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { compileQuestionResponseProtocol } from "../../shared/question-response-protocol";
import { LiveChatPage } from "./live-chat-page";

vi.mock("../components/avatar/avatar-crop-dialog", () => ({
  AvatarCropDialog: (props: {
    onCancel(): void;
    onConfirm(crop: { x: number; y: number; width: number; height: number }): void;
  }) => (
    <section role="dialog" aria-label="调整头像">
      <button type="button" onClick={props.onCancel}>取消裁剪</button>
      <button type="button" onClick={() => props.onConfirm({ x: 10, y: 10, width: 80, height: 80 })}>裁剪并上传</button>
    </section>
  ),
}));

type EventListener = (event: Event) => void;
const operationLog: string[] = [];
let regenerateResponse: Promise<Response> | undefined;
let historyResponse: Response | undefined;
let historyWindowResponse: Response | undefined;
let sessionOneSnapshot: Record<string, unknown> | undefined;
let sessionTwoSnapshot: Record<string, unknown> | undefined;
let questionAnswerResponse: Promise<Response> | undefined;
let messageResponse: Promise<Response> | undefined;
let abortResponse: Promise<Response> | undefined;
let editResponse: Promise<Response> | undefined;
let thinkingLevelResponse: Promise<Response> | undefined;
let archiveResponse: Promise<Response> | undefined;
let deleteResponse: Promise<Response> | undefined;
let sessionListResponseQueue: Promise<Response>[] = [];
let documentVisibilityState: DocumentVisibilityState = "visible";
const intersectionObserverCallbacks: IntersectionObserverCallback[] = [];

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  let reject: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class HistoryObserverDouble {
  constructor(callback: IntersectionObserverCallback) {
    intersectionObserverCallbacks.push(callback);
  }

  observe() {}
  disconnect() {}
  unobserve() {}
  takeRecords() { return []; }
  readonly root = null;
  readonly rootMargin = "";
  readonly thresholds = [];
}

class FakeEventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  static reportErrorOnClose = false;
  readyState = FakeEventSource.OPEN;
  readonly listeners = new Map<string, EventListener[]>();
  onerror: (() => void) | null = null;
  closed = false;
  private nextEventId = 1;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
    operationLog.push(`sse:${url}`);
  }

  addEventListener(type: string, listener: EventListener) {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  close() {
    this.closed = true;
    this.readyState = FakeEventSource.CLOSED;
    if (FakeEventSource.reportErrorOnClose) this.onerror?.();
  }

  /** 模拟浏览器完成 EventSource 自动重连。 */
  emitOpen() {
    this.readyState = FakeEventSource.OPEN;
    const event = { data: "" } as MessageEvent;
    this.listeners.get("open")?.forEach((listener) => listener(event));
  }

  /** 模拟浏览器把原生连接错误同时分发给 error 监听器和 onerror。 */
  emitTransportError() {
    this.readyState = FakeEventSource.CONNECTING;
    const event = new Event("error");
    this.listeners.get("error")?.forEach((listener) => listener(event));
    this.onerror?.();
  }

  emit(type: string, payload: unknown) {
    const sessionId = decodeURIComponent(this.url.match(/\/sessions\/([^/]+)\/events/)?.[1] ?? "");
    const original = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const suppliedId = typeof original.id === "number" ? original.id : undefined;
    const id = suppliedId ?? this.nextEventId;
    this.nextEventId = Math.max(this.nextEventId, id + 1);
    const isRunScopedEvent = !["snapshot", "projection_required", "session_renamed", "question_pending", "question_resolved"].includes(type);
    const normalized = {
      id,
      type,
      sessionId,
      ...(isRunScopedEvent ? { runId: "run-1" } : {}),
      ...(type === "snapshot" ? { history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 1 } } : {}),
      ...original,
      ...(type === "snapshot" && original.lastEventId === undefined ? { lastEventId: id } : {}),
    };
    const event = { data: JSON.stringify(normalized) } as MessageEvent;
    this.listeners.get(type)?.forEach((listener) => listener(event));
  }
}

/** 记录跨标签页会话列表广播，验证失败请求不会误通知其他页面。 */
class RecordingBroadcastChannel {
  static instances: RecordingBroadcastChannel[] = [];
  readonly messages: unknown[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;

  constructor(readonly name: string) {
    RecordingBroadcastChannel.instances.push(this);
  }

  postMessage(message: unknown): void {
    this.messages.push(message);
  }

  close(): void {}
}

/** 页面级音频桩保留播放状态，便于验证按钮和导航触发的停止行为。 */
class PageFakeAudio {
  static instances: PageFakeAudio[] = [];
  readonly listeners = new Map<"ended" | "error", Array<() => void>>();
  played = false;
  paused = false;

  constructor(readonly src: string) {
    PageFakeAudio.instances.push(this);
  }

  async play(): Promise<void> {
    this.played = true;
  }

  pause(): void {
    this.paused = true;
  }

  addEventListener(type: "ended" | "error", listener: () => void): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  finish(): void {
    this.listeners.get("ended")?.forEach((listener) => listener());
  }
}

const props = {
  theme: "light" as const,
  onThemeChange: vi.fn(),
  userIdentity: { displayName: "管理员", avatarText: "A" },
  agentIdentity: { displayName: "默认 Agent", avatarText: "π" },
};

const pendingQuestion = {
  id: "question-1",
  version: 1,
  toolCallId: "ask-1",
  createdAt: "2026-08-13T08:00:00.000Z",
  questions: [{
    id: "q-1",
    header: "范围",
    question: "需要处理哪些内容？",
    multiSelect: false,
    options: [
      { id: "o-1", label: "全部", description: "处理全部内容" },
      { id: "o-2", label: "部分", description: "只处理一部分" },
    ],
  }, {
    id: "q-2",
    header: "格式",
    question: "需要哪种格式？",
    multiSelect: true,
    options: [
      { id: "o-3", label: "Markdown", description: "生成 Markdown" },
      { id: "o-4", label: "HTML", description: "生成 HTML" },
    ],
  }],
};

/** 使用生产环境一致的异步任务和错误提示上下文渲染聊天页面。 */
function renderLiveChatPage(element: ReactElement) {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>{element}</ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

/** 只读取消息气泡，避免用户消息导航中的摘要影响时间线断言。 */
function messageRowTexts(): string[] {
  return [...document.querySelectorAll<HTMLElement>(".message-row")]
    .map((row) => row.textContent ?? "");
}

function mediaQueryResult(matches: boolean): MediaQueryList {
  return {
    matches,
    media: "",
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  FakeEventSource.reportErrorOnClose = false;
  RecordingBroadcastChannel.instances = [];
  PageFakeAudio.instances = [];
  operationLog.length = 0;
  regenerateResponse = undefined;
  historyResponse = undefined;
  historyWindowResponse = undefined;
  sessionOneSnapshot = undefined;
  sessionTwoSnapshot = undefined;
  questionAnswerResponse = undefined;
  messageResponse = undefined;
  abortResponse = undefined;
  editResponse = undefined;
  thinkingLevelResponse = undefined;
  archiveResponse = undefined;
  deleteResponse = undefined;
  sessionListResponseQueue = [];
  documentVisibilityState = "visible";
  intersectionObserverCallbacks.length = 0;
  window.sessionStorage.clear();
  window.localStorage.clear();
  vi.stubGlobal("EventSource", FakeEventSource);
  vi.stubGlobal("BroadcastChannel", RecordingBroadcastChannel);
  vi.stubGlobal("IntersectionObserver", HistoryObserverDouble);
  vi.stubGlobal("matchMedia", vi.fn(() => mediaQueryResult(false)));
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => documentVisibilityState);
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    operationLog.push(`fetch:${init?.method ?? "GET"}:${url}`);
    if (url === "/api/v1/agents") {
      return new Response(JSON.stringify({ agents: [{ profile: { id: "default", name: "默认 Agent", avatar: { kind: "initial", value: "π" }, description: "用于测试的 Agent", status: "active", cwd: "/data/workspace", instructions: {}, allowedTools: [] }, revision: "r1" }] }));
    }
    if (url === "/api/v1/sessions" && init?.method === "POST") {
      return new Response(JSON.stringify({ id: "session-new", agentId: "default", messages: [], lastEventId: 0 }));
    }
    if (url === "/api/v1/sessions?agentId=default") {
      const queued = sessionListResponseQueue.shift();
      if (queued) return queued;
      return new Response(JSON.stringify({ sessions: [
        { id: "session-1", firstMessage: "测试", modified: "", messageCount: 0 },
        { id: "session-2", firstMessage: "第二会话", modified: "", messageCount: 2, scheduledTaskCount: 2 },
      ] }));
    }
    if (url === "/api/v1/sessions?agentId=default&archived=true") {
      return new Response(JSON.stringify({ sessions: [{ id: "archived-1", name: "旧会话", firstMessage: "旧问题", modified: "", messageCount: 2 }] }));
    }
    if (url.startsWith("/api/v1/sessions/search?agentId=default&query=")) {
      return new Response(JSON.stringify({
        hits: [{
          sessionId: "session-2",
          sessionFirstMessage: "第二会话",
          archived: false,
          entryId: "assistant-25",
          role: "assistant",
          timestamp: "2026-08-13T01:00:00.000Z",
          snippet: "包含 needle 的回答",
          matchRanges: [{ start: 3, end: 9 }],
        }],
        hasMore: false,
      }));
    }
    if (url === "/api/v1/models") {
      return new Response(JSON.stringify({ models: [{
        provider: "openai", id: "gpt-5", name: "GPT-5-超长模型名称用于移动端输入区回归验证",
        thinkingLevels: ["off", "minimal", "low", "medium", "high"],
      }] }));
    }
    if (url.includes("/workspace/entries")) {
      return new Response(JSON.stringify({ entries: [] }));
    }
    if (url === "/api/v1/sessions/bulk/preview" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        action: "archive" | "restore" | "delete";
        target: { mode: "selected"; sessionIds: string[] } | { mode: "all_archived"; agentId: string };
      };
      const sessionIds = body.target.mode === "selected" ? body.target.sessionIds : ["archived-1"];
      return new Response(JSON.stringify({
        ...body,
        sessionCount: sessionIds.length,
        tasks: body.action === "delete" && (sessionIds.includes("session-2") || body.target.mode === "all_archived") ? [
          { id: "task-1", name: "日报", sessionId: "session-2" },
          { id: "task-2", name: "周报", sessionId: "session-2" },
        ] : [],
        fingerprint: "fingerprint-1",
      }));
    }
    if (url === "/api/v1/sessions/bulk" && init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as {
        action: "archive" | "restore" | "delete";
        target: { mode: "selected"; sessionIds: string[] } | { mode: "all_archived"; agentId: string };
      };
      const sessionCount = body.target.mode === "selected" ? body.target.sessionIds.length : 1;
      return new Response(JSON.stringify({ action: body.action, sessionCount, affectedTaskCount: 2 }));
    }
    if (url === "/api/v1/sessions/session-1" && init?.method === "DELETE") {
      return deleteResponse ?? new Response(null, { status: 204 });
    }
    if (url === "/api/v1/sessions/session-1") {
      return new Response(JSON.stringify(sessionOneSnapshot ?? {
        id: "session-1",
        messages: [],
        history: { branchToken: "branch-a", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
        thinkingLevel: "medium",
        lastEventId: 0,
      }));
    }
    if (url === "/api/v1/sessions/session-1/thinking-level" && init?.method === "PUT") {
      return thinkingLevelResponse ?? new Response(null, { status: 204 });
    }
    if (url === "/api/v1/sessions/session-1/archive" && init?.method === "POST") {
      return archiveResponse ?? new Response(null, { status: 204 });
    }
    if (url === "/api/v1/sessions/session-2") {
      return new Response(JSON.stringify(sessionTwoSnapshot ?? {
        id: "session-2",
        agentId: "default",
        messages: [{ role: "user", content: "第二会话问题", __piEntryId: "session-2-user" }],
        history: { branchToken: "branch-session-2", hasMoreBefore: false, hasMoreAfter: false, turnCount: 1 },
        thinkingLevel: "high",
        lastEventId: 1,
      }));
    }
    if (url === "/api/v1/sessions/session-2/history-window?entryId=assistant-25&branch=branch-session-2") {
      return historyWindowResponse ?? new Response(JSON.stringify({
        sessionId: "session-2",
        targetEntryId: "assistant-25",
        messages: [
          { role: "user", content: "窗口问题", __piEntryId: "user-25" },
          { role: "assistant", content: [{ type: "text", text: "包含 needle 的回答" }], __piEntryId: "assistant-25" },
        ],
        history: {
          startEntryId: "user-25",
          endEntryId: "assistant-25",
          branchToken: "branch-session-2",
          hasMoreBefore: true,
          hasMoreAfter: true,
          turnCount: 1,
        },
      }));
    }
    if (url === "/api/v1/sessions/archived-1") {
      return new Response(JSON.stringify({ id: "archived-1", agentId: "default", messages: [], lastEventId: 0 }));
    }
    if (url.endsWith("/edit")) {
      return editResponse ?? new Response(JSON.stringify({ snapshot: { id: "session-1", messages: [], lastEventId: 0 }, draft: { text: "编辑后的版本", filePaths: [], missingFilePaths: [], references: [] } }));
    }
    if (url.endsWith("/navigate")) {
      return new Response(JSON.stringify({
        id: "session-1",
        messages: [{ role: "user", content: "上一版本", __piEntryId: "user-old" }],
        history: { branchToken: "branch-b", hasMoreBefore: false, hasMoreAfter: false, turnCount: 1 },
        lastEventId: 2,
      }));
    }
    if (url.endsWith("/regenerate")) {
      return regenerateResponse ?? Promise.resolve(new Response(JSON.stringify({
        snapshot: {
          id: "session-1",
          messages: [],
          history: { branchToken: "branch-regenerated", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
          lastEventId: 3,
        },
        run: {
          runId: "run-regenerated",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-12T00:00:00.000Z",
        },
      })));
    }
    if (url.includes("/history?")) {
      return historyResponse ?? new Response(JSON.stringify({}), { status: 500 });
    }
    if (url.includes("/branches/") && url.endsWith("/messages")) {
      return new Response(JSON.stringify({
        snapshot: {
          id: "session-1",
          messages: [
            { role: "user", content: "上一条" },
            { role: "assistant", content: [{ type: "text", text: "旧回答" }] },
          ],
          lastEventId: 2,
        },
        run: {
          runId: "run-branch",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-05T08:00:00.000Z",
        },
      }));
    }
    if (url === "/api/v1/sessions/session-1/questions/question-1/answers" && init?.method === "POST") {
      return questionAnswerResponse ?? new Response(JSON.stringify({
        run: {
          runId: "run-question-answer",
          sessionId: "session-1",
          status: "running",
          startedAt: "2026-08-13T08:10:00.000Z",
        },
        resolution: {
          resolutionId: "resolution-live",
          questionRecordId: "question-1",
          status: "submitted",
          answers: [{ questionId: "q-1", kind: "options", optionIds: ["o-2"] }],
          unansweredQuestionIds: ["q-2"],
        },
      }));
    }
    if (url === "/api/v1/sessions/session-1/abort" && init?.method === "POST") {
      return abortResponse ?? new Response(null, { status: 204 });
    }
    if (url.endsWith("/messages")) {
      const sessionId = url.split("/")[3];
      return messageResponse ?? new Response(JSON.stringify({
        runId: "run-1",
        sessionId,
        status: "running",
        startedAt: "2026-08-05T08:00:00.000Z",
      }));
    }
    if (url === "/api/v1/agents/default/attachments") {
      return new Response(JSON.stringify({
        files: [{
          path: "attachments/图片.png",
          name: "图片.png",
          mediaType: "image/png",
          size: 5,
          modifiedAt: "2026-08-05T08:00:00.000Z",
        }],
      }));
    }
    if (url.includes("/api/v1/agents/default/files/")) {
      return new Response(null, {
        headers: {
          "Content-Type": "image/png",
          "Content-Length": "5",
          "Last-Modified": "Wed, 05 Aug 2026 08:00:00 GMT",
        },
      });
    }
    if (url === "/api/v1/agents/default/data-files?path=outputs%2Fresult.mp4" && init?.method === "HEAD") {
      return new Response(null, {
        headers: {
          "Content-Type": "video/mp4",
          "Content-Length": "128",
          "Last-Modified": "Tue, 08 Sep 2026 08:00:00 GMT",
          "X-BugPaw-File-Name": encodeURIComponent("result.mp4"),
          "X-BugPaw-File-Path": encodeURIComponent("/data/workspace/outputs/result.mp4"),
        },
      });
    }
    return new Response(JSON.stringify({}), { status: 200 });
  }));
});

describe("LiveChatPage 时间线", () => {

it("粗指针环境仍按键盘修饰键区分发送与换行", async () => {
  vi.stubGlobal("matchMedia", vi.fn((query: string) => mediaQueryResult(query === "(pointer: coarse)")));
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  const composer = screen.getByRole("textbox", { name: "消息内容" });
  fireEvent.change(composer, { target: { value: "键盘发送测试" } });

  fireEvent.keyDown(composer, { key: "Enter", code: "Enter", shiftKey: true });
  expect(operationLog).not.toContain("fetch:POST:/api/v1/sessions/session-1/messages");

  fireEvent.keyDown(composer, { key: "Enter", code: "Enter" });
  await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-1/messages"));
  await screen.findByRole("button", { name: "停止生成" });
});

it("打开会话时立即按权威快照同步发送按钮状态", async () => {
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    thinkingLevel: "medium",
    run: {
      runId: "run-session-1",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-09T00:00:00.000Z",
    },
    lastEventId: 1,
  };

  renderLiveChatPage(<LiveChatPage {...props} />);

  await screen.findByRole("button", { name: "停止生成" });
  fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
  await screen.findByRole("button", { name: "发送消息" });
});

it("Projection 恢复时同步服务端运行状态", async () => {
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    thinkingLevel: "medium",
    run: {
      runId: "run-recovered",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-09T00:01:00.000Z",
    },
    lastEventId: 8,
  };

  act(() => FakeEventSource.instances[0]!.emit("projection_required", { lastEventId: 8 }));

  await screen.findByRole("button", { name: "停止生成" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
});

it("运行中会话的原生连接错误不会被当作 error 业务事件解析", async () => {
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    history: { branchToken: "branch-running", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    thinkingLevel: "medium",
    run: {
      runId: "run-session-1",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-09T00:00:00.000Z",
    },
    lastEventId: 18,
  };
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "停止生成" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

  act(() => FakeEventSource.instances[0]!.emitTransportError());

  expect(await screen.findByText("会话实时连接中断，EventSource 未提供 HTTP 状态，浏览器正在自动重连")).toBeVisible();
  expect(screen.queryByText(/会话实时事件“error”未通过JSON 解析/u)).not.toBeInTheDocument();
  expect(FakeEventSource.instances).toHaveLength(1);
});

it("息屏期间断线后在页面恢复可见时按最后游标重建实时连接", async () => {
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    history: { branchToken: "branch-resume", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    thinkingLevel: "medium",
    run: {
      runId: "run-session-1",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-13T00:00:00.000Z",
    },
    lastEventId: 18,
  };
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "停止生成" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const suspendedSource = FakeEventSource.instances[0]!;

  documentVisibilityState = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  act(() => suspendedSource.emitTransportError());
  expect(FakeEventSource.instances).toHaveLength(1);

  documentVisibilityState = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));

  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(suspendedSource.closed).toBe(true);
  expect(FakeEventSource.instances[1]!.url).toBe("/api/v1/sessions/session-1/events?after=18");
  await waitFor(() => expect(screen.queryByText("实时连接暂时中断，浏览器会自动重连。")).not.toBeInTheDocument());
});

it("前台断线超过原生重连宽限期后主动重建实时连接", async () => {
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const stalledSource = FakeEventSource.instances[0]!;

  act(() => stalledSource.emitTransportError());

  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2), { timeout: 3_000 });
  expect(stalledSource.closed).toBe(true);
  expect(FakeEventSource.instances[1]!.url).toBe("/api/v1/sessions/session-1/events?after=0");
});

it("息屏后的僵尸 OPEN 连接会按最后游标重建并接收遗漏终态", async () => {
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    history: { branchToken: "branch-zombie-open", hasMoreBefore: false, hasMoreAfter: false, turnCount: 0 },
    thinkingLevel: "medium",
    run: {
      runId: "run-session-1",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-13T00:00:00.000Z",
    },
    lastEventId: 18,
  };
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "停止生成" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const zombieSource = FakeEventSource.instances[0]!;

  documentVisibilityState = "hidden";
  act(() => document.dispatchEvent(new Event("visibilitychange")));
  documentVisibilityState = "visible";
  act(() => document.dispatchEvent(new Event("visibilitychange")));

  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(zombieSource.closed).toBe(true);
  expect(FakeEventSource.instances[1]!.url).toBe("/api/v1/sessions/session-1/events?after=18");

  act(() => FakeEventSource.instances[1]!.emit("completed", { id: 19 }));

  await screen.findByRole("button", { name: "发送消息" });
});

it("提交轮次事件用稳定节点替换本地待发送消息", async () => {
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "当前问题" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByRole("button", { name: "停止生成" });

  act(() => FakeEventSource.instances[0]!.emit("turn_committed", {
    messages: [{ role: "user", content: "当前问题", __piEntryId: "user-current" }],
    history: {
      startEntryId: "user-current",
      endEntryId: "user-current",
      branchToken: "branch-a",
      hasMoreBefore: false,
      hasMoreAfter: false,
      turnCount: 1,
    },
  }));

  expect(messageRowTexts().filter((text) => text.includes("当前问题"))).toHaveLength(1);
});

it("SSE 终态不会被迟到的发送响应覆盖", async () => {
  const pendingMessage = deferred<Response>();
  messageResponse = pendingMessage.promise;
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "测试迟到响应" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await screen.findByRole("button", { name: "停止生成" });

  act(() => FakeEventSource.instances.at(-1)!.emit("completed", {}));
  await screen.findByRole("button", { name: "发送消息" });
  pendingMessage.resolve(new Response(JSON.stringify({
    runId: "run-late",
    sessionId: "session-1",
    status: "running",
    startedAt: "2026-09-09T00:02:00.000Z",
  })));

  await waitFor(() => expect(screen.getByRole("button", { name: "发送消息" })).toBeVisible());
});

it("发送响应丢失后通过权威快照恢复真实运行状态", async () => {
  const pendingMessage = deferred<Response>();
  messageResponse = pendingMessage.promise;
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "测试失败恢复" } });
  fireEvent.click(screen.getByRole("button", { name: "发送消息" }));
  await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-1/messages"));
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    thinkingLevel: "medium",
    run: {
      runId: "run-server-started",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-09T00:03:00.000Z",
    },
    lastEventId: 4,
  };
  pendingMessage.reject(new TypeError("连接已断开"));

  await screen.findByRole("button", { name: "停止生成" });
});

it("停止接口返回 204 后用权威快照清除残留运行状态", async () => {
  const pendingAbort = deferred<Response>();
  abortResponse = pendingAbort.promise;
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    thinkingLevel: "medium",
    run: {
      runId: "run-stale",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-09T00:04:00.000Z",
    },
    lastEventId: 5,
  };
  renderLiveChatPage(<LiveChatPage {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "停止生成" }));
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [],
    thinkingLevel: "medium",
    lastEventId: 5,
  };
  pendingAbort.resolve(new Response(null, { status: 204 }));

  await screen.findByRole("button", { name: "发送消息" });
});

it("旧会话的迟到事件不能污染当前会话", async () => {
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const oldSource = FakeEventSource.instances.at(-1)!;
  fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  act(() => oldSource.emit("run_started", {
    run: {
      runId: "run-old-session",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-09-09T00:05:00.000Z",
    },
  }));

  expect(screen.getByRole("button", { name: "发送消息" })).toBeVisible();
});

it("删除当前会话时服务端先断流不会上报断线错误", async () => {
  const pendingDelete = deferred<Response>();
  deleteResponse = pendingDelete.promise;
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
  const deletedSource = FakeEventSource.instances[0]!;

  fireEvent.click(screen.getByRole("button", { name: "管理会话：测试" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除" }));

  await waitFor(() => expect(operationLog).toContain("fetch:DELETE:/api/v1/sessions/session-1"));
  expect(deletedSource.closed).toBe(true);
  act(() => deletedSource.emitTransportError());
  expect(screen.queryByText(/会话实时连接中断/u)).not.toBeInTheDocument();
  expect(screen.queryByText("恢复会话实时连接")).not.toBeInTheDocument();

  pendingDelete.resolve(new Response(null, { status: 204 }));
  await waitFor(() => expect(screen.queryByRole("button", { name: "管理会话：测试" })).not.toBeInTheDocument());
});

it("删除当前会话失败后恢复实时连接", async () => {
  const pendingDelete = deferred<Response>();
  deleteResponse = pendingDelete.promise;
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

  fireEvent.click(screen.getByRole("button", { name: "管理会话：测试" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "删除" }));
  fireEvent.click(screen.getByRole("button", { name: "永久删除" }));
  await waitFor(() => expect(operationLog).toContain("fetch:DELETE:/api/v1/sessions/session-1"));
  expect(FakeEventSource.instances[0]?.closed).toBe(true);

  pendingDelete.resolve(new Response(JSON.stringify({
    error: { code: "DELETE_SESSION_FAILED", message: "会话文件删除失败", requestId: "delete-request-1" },
  }), { status: 500 }));

  await waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  expect(FakeEventSource.instances[1]!.url).toBe("/api/v1/sessions/session-1/events?after=0");
  expect(await screen.findByText("删除会话失败")).toBeVisible();
});

it("归档旧会话的迟到响应不会清空已经打开的新会话", async () => {
  const pendingArchive = deferred<Response>();
  archiveResponse = pendingArchive.promise;
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });

  fireEvent.click(screen.getByRole("button", { name: "管理会话：测试" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "归档" }));
  await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-1/archive"));
  fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
  await waitFor(() => expect(messageRowTexts().some((text) => text.includes("第二会话问题"))).toBe(true));

  pendingArchive.resolve(new Response(null, { status: 204 }));

  await waitFor(() => expect(screen.getByRole("button", { name: /^第二会话/ }).closest(".session-row")).toHaveClass("is-active"));
  expect(messageRowTexts().some((text) => text.includes("第二会话问题"))).toBe(true);
});

it("跨标签页同步的旧列表响应不会覆盖较新的手动刷新结果", async () => {
  renderLiveChatPage(<LiveChatPage {...props} />);
  await screen.findByRole("button", { name: "发送消息" });
  await waitFor(() => expect(RecordingBroadcastChannel.instances.length).toBeGreaterThan(0));
  const staleList = deferred<Response>();
  const latestList = deferred<Response>();
  sessionListResponseQueue.push(staleList.promise, latestList.promise);
  const initialRequestCount = operationLog.filter((entry) => entry === "fetch:GET:/api/v1/sessions?agentId=default").length;

  act(() => RecordingBroadcastChannel.instances.at(-1)?.onmessage?.({ data: "sessions-invalidated" } as MessageEvent));
  await waitFor(() => expect(operationLog.filter((entry) => entry === "fetch:GET:/api/v1/sessions?agentId=default")).toHaveLength(initialRequestCount + 1));
  fireEvent.click(screen.getByRole("button", { name: "刷新会话列表" }));
  await waitFor(() => expect(operationLog.filter((entry) => entry === "fetch:GET:/api/v1/sessions?agentId=default")).toHaveLength(initialRequestCount + 2));

  latestList.resolve(new Response(JSON.stringify({ sessions: [
    { id: "session-1", firstMessage: "测试", modified: "", messageCount: 0 },
    { id: "session-2", name: "最新列表", firstMessage: "第二会话", modified: "", messageCount: 2 },
  ] })));
  await screen.findByRole("button", { name: /^最新列表/ });
  staleList.resolve(new Response(JSON.stringify({ sessions: [
    { id: "session-1", firstMessage: "测试", modified: "", messageCount: 0 },
    { id: "session-2", name: "旧列表", firstMessage: "第二会话", modified: "", messageCount: 2 },
  ] })));

  await waitFor(() => expect(screen.queryByRole("button", { name: /^旧列表/ })).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: /^最新列表/ })).toBeVisible();
});

it("切换会话后丢弃迟到的历史编辑响应", async () => {
  const pendingEdit = deferred<Response>();
  editResponse = pendingEdit.promise;
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [{ role: "user", content: "准备编辑的旧消息", __piEntryId: "user-edit" }],
    history: { branchToken: "branch-edit", hasMoreBefore: false, hasMoreAfter: false, turnCount: 1 },
    thinkingLevel: "medium",
    lastEventId: 1,
  };
  renderLiveChatPage(<LiveChatPage {...props} />);
  fireEvent.click(await screen.findByRole("button", { name: "重新编辑消息" }));
  await waitFor(() => expect(operationLog.some((entry) => entry.includes("/branches/user-edit/edit"))).toBe(true));

  fireEvent.click(screen.getByRole("button", { name: /^第二会话/ }));
  await waitFor(() => expect(messageRowTexts().some((text) => text.includes("第二会话问题"))).toBe(true));
  pendingEdit.resolve(new Response(JSON.stringify({
    snapshot: { id: "session-1", messages: [], lastEventId: 1 },
    draft: { text: "不应进入新会话的草稿", filePaths: [], missingFilePaths: [], references: [] },
  })));

  await waitFor(() => expect(screen.getByRole("textbox", { name: "消息内容" })).toHaveValue(""));
  expect(screen.queryByText("正在编辑历史消息")).not.toBeInTheDocument();
});

it("思考深度尚未确认时禁止发送消息", async () => {
  const pendingThinkingLevel = deferred<Response>();
  thinkingLevelResponse = pendingThinkingLevel.promise;
  renderLiveChatPage(<LiveChatPage {...props} />);
  const sendButton = await screen.findByRole("button", { name: "发送消息" });

  fireEvent.click(screen.getByRole("button", { name: "思考深度：中" }));
  fireEvent.click(screen.getByRole("option", { name: "高 high" }));

  await waitFor(() => expect(operationLog).toContain("fetch:PUT:/api/v1/sessions/session-1/thinking-level"));
  expect(sendButton).toBeDisabled();
  pendingThinkingLevel.resolve(new Response(null, { status: 204 }));
  await waitFor(() => expect(sendButton).toBeEnabled());
});

it("草稿首次发送只创建一个 session 并先建立其事件流", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    fireEvent.click(screen.getByRole("button", { name: "新对话" }));
    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "第一条消息" } });

    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await screen.findByRole("button", { name: "停止生成" });
    await waitFor(() => expect(operationLog).toContain("fetch:POST:/api/v1/sessions/session-new/messages"));
    expect(operationLog.filter((entry) => entry === "fetch:POST:/api/v1/sessions")).toHaveLength(1);
    expect(operationLog.indexOf("sse:/api/v1/sessions/session-new/events?after=0"))
      .toBeLessThan(operationLog.indexOf("fetch:POST:/api/v1/sessions/session-new/messages"));
  });

it("上传附件后携带相对路径发送并在用户消息中展示媒体", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
    const file = new File(["image"], "图片.png", { type: "image/png" });

    const picker = screen.getByRole("button", { name: "添加附件" });
    const input = picker.parentElement?.querySelector("input[type=file]");
    expect(input).toBeInTheDocument();
    fireEvent.change(input!, { target: { files: [file] } });
    await waitFor(() => expect(screen.getByText("5 B")).toBeInTheDocument());
    fireEvent.change(screen.getByRole("textbox", { name: "消息内容" }), { target: { value: "分析图片" } });
    fireEvent.click(screen.getByRole("button", { name: "发送消息" }));

    await waitFor(() => {
      const messageCall = vi.mocked(fetch).mock.calls.find(([url]) => String(url) === "/api/v1/sessions/session-1/messages");
      expect(messageCall).toBeDefined();
      expect(JSON.parse(String(messageCall?.[1]?.body))).toMatchObject({
        text: "分析图片",
        filePaths: ["attachments/图片.png"],
      });
    });
  expect(screen.getByRole("img", { name: "图片.png" })).toBeInTheDocument();
});

it("Agent 的 Markdown 文件链接保持行内展示并按需打开预览", async () => {
  sessionOneSnapshot = {
    id: "session-1",
    agentId: "default",
    messages: [{
      role: "assistant",
      content: [{
        type: "text",
        text: "[演示视频](outputs/result.mp4)\n\n[外部图片](https://example.com/image.png)\n\n<pi_agent_files version=\"1\">\n{\"files\":[{\"path\":\"legacy.png\"}]}\n</pi_agent_files>",
      }],
      __piEntryId: "assistant-file-links",
    }],
    history: { branchToken: "branch-file-links", hasMoreBefore: false, hasMoreAfter: false, turnCount: 1 },
    thinkingLevel: "medium",
    lastEventId: 1,
  };

  renderLiveChatPage(<LiveChatPage {...props} />);

  const fileLink = await screen.findByRole("link", { name: "演示视频" });
  expect(fileLink.querySelector(".markdown-file-link__icon")).not.toBeNull();
  const externalLink = screen.getByRole("link", { name: "外部图片" });
  expect(externalLink).toHaveAttribute("target", "_blank");
  expect(document.querySelector(".media-attachment")).toBeNull();
  expect(screen.getByText(/legacy\.png/)).toBeInTheDocument();

  fireEvent.click(fileLink);

  const dialog = await screen.findByRole("dialog", { name: "result.mp4" });
  expect(within(dialog).getByText("128 B · video/mp4")).toBeInTheDocument();
  expect(dialog.querySelector("video")).toHaveAttribute("src", "/api/v1/agents/default/data-files?path=%2Fdata%2Fworkspace%2Foutputs%2Fresult.mp4");
  expect(operationLog).toContain("fetch:HEAD:/api/v1/agents/default/data-files?path=outputs%2Fresult.mp4");
});

});

describe("LiveChatPage 提问处理", () => {
  it("收到提问后切换处理框，并支持收起后继续回答", async () => {
    renderLiveChatPage(<LiveChatPage {...props} />);
    await screen.findByRole("button", { name: "测试" });
    await waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    act(() => FakeEventSource.instances.at(-1)!.emit("question_pending", {
      type: "question_pending",
      pendingQuestion,
    }));

    expect(screen.getByText("问题 1/2")).toBeVisible();
    expect(screen.queryByPlaceholderText("给 Agent 发消息…（输入 @ 引用资源）")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: /全部/ }));
    fireEvent.click(screen.getByRole("button", { name: "收起提问处理框" }));

    expect(screen.getByPlaceholderText("给 Agent 发消息…（输入 @ 引用资源）")).toBeVisible();
    expect(screen.getByRole("button", { name: "继续回答 · 1/2" })).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "继续回答 · 1/2" }));
    expect(screen.getByRole("radio", { name: /全部/ })).toBeChecked();
  });

});

function questionAnswerResult(): Response {
  return new Response(JSON.stringify({
    run: {
      runId: "run-question-answer",
      sessionId: "session-1",
      status: "running",
      startedAt: "2026-08-13T08:10:00.000Z",
    },
    resolution: {
      resolutionId: "resolution-live",
      questionRecordId: "question-1",
      status: "submitted",
      answers: [{ questionId: "q-1", kind: "options", optionIds: ["o-2"] }],
      unansweredQuestionIds: ["q-2"],
    },
  }));
}
