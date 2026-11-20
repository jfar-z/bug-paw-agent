import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { unexpectedErrorDedupeKey } from "./api-error-policy";
import { Toast } from "./ui/toast";
import type { ErrorToastController, ErrorToastInput, ErrorToastItem } from "./error-toast-types";
import { subscribeGlobalErrors } from "./global-error-events";

const DEFAULT_DURATION_MS = 8000;
const MAX_VISIBLE_TOASTS = 3;

interface ManagedToast extends ErrorToastItem {
  dedupeKey: string;
  pausedBy: Array<"expanded" | "hover" | "focus">;
  startedAt?: number;
}

interface ToastAnnouncement {
  id: string;
  text: string;
}

const ErrorToastContext = createContext<ErrorToastController | undefined>(undefined);
const ErrorToastModalContext = createContext<{
  registerModal: (modal: HTMLDialogElement) => () => void;
  activeModal: HTMLDialogElement | undefined;
  renderToast: (restoreFocus?: () => void) => ReactNode;
} | undefined>(undefined);

/** 模态打开时将全局错误提示呈现在原生顶层，保留详情操作和播报。 */
export function useErrorToastModal() {
  return useContext(ErrorToastModalContext);
}

/** 在应用根部维护错误提示队列，并向业务组件提供稳定控制器。 */
export function ErrorToastProvider({ children }: { children: ReactNode }) {
  const sequence = useRef(0);
  const [items, setItems] = useState<ManagedToast[]>([]);
  const itemsRef = useRef<ManagedToast[]>([]);
  const [announcement, setAnnouncement] = useState<ToastAnnouncement>();
  const [modals, setModals] = useState<HTMLDialogElement[]>([]);
  const registerModal = useCallback((modal: HTMLDialogElement) => {
    setModals((current) => [...current, modal]);
    return () => setModals((current) => current.filter((entry) => entry !== modal));
  }, []);

  const dismiss = useCallback((id: string) => {
    setItems((current) => {
      const now = Date.now();
      let promoted: ManagedToast | undefined;
      const next = current.filter((item) => item.id !== id).map((item, index) => {
        if (index >= MAX_VISIBLE_TOASTS || item.paused || item.startedAt !== undefined) return item;
        promoted = item;
        return { ...item, startedAt: now };
      });
      itemsRef.current = next;
      if (promoted) {
        setAnnouncement({ id: promoted.id, text: `${promoted.title}。${promoted.summary}` });
      }
      return next;
    });
  }, []);

  const push = useCallback((input: ErrorToastInput) => {
    const dedupeKey = unexpectedErrorDedupeKey(input);
    const duplicate = itemsRef.current.find((item) => item.dedupeKey === dedupeKey);
    if (duplicate) return duplicate.id;
    const resolvedId = `error-toast-${++sequence.current}`;
    const durationMs = input.durationMs ?? DEFAULT_DURATION_MS;
    const item: ManagedToast = {
      ...input,
      id: resolvedId,
      durationMs,
      remainingMs: durationMs,
      expanded: false,
      paused: false,
      pausedBy: [],
      dedupeKey,
      ...(itemsRef.current.length < MAX_VISIBLE_TOASTS ? { startedAt: Date.now() } : {}),
    };
    itemsRef.current = [...itemsRef.current, item];
    setItems(itemsRef.current);
    if (item.startedAt !== undefined) {
      setAnnouncement({ id: item.id, text: `${input.title}。${input.summary}` });
    }
    return resolvedId;
  }, []);

  const clear = useCallback(() => {
    itemsRef.current = [];
    setItems([]);
    setAnnouncement(undefined);
  }, []);

  useEffect(() => subscribeGlobalErrors(push), [push]);

  const setExpanded = useCallback((id: string, expanded: boolean) => {
    setItems((current) => {
      const next = current.map((item) => {
        if (item.id !== id) return item;
        const pausedBy = expanded
          ? [...new Set([...item.pausedBy, "expanded" as const])]
          : item.pausedBy.filter((source) => source !== "expanded");
        return updateTiming(item, pausedBy, pausedBy.length > 0, { expanded });
      });
      itemsRef.current = next;
      return next;
    });
  }, []);

  const setPaused = useCallback((id: string, source: "hover" | "focus", paused: boolean) => {
    setItems((current) => {
      const next = current.map((item) => {
        if (item.id !== id) return item;
        const pausedBy = paused
          ? [...new Set([...item.pausedBy, source])]
          : item.pausedBy.filter((candidate) => candidate !== source);
        return updateTiming(item, pausedBy, pausedBy.length > 0);
      });
      itemsRef.current = next;
      return next;
    });
  }, []);

  useEffect(() => {
    const now = Date.now();
    const timers = items.slice(0, MAX_VISIBLE_TOASTS).flatMap((item) => {
      if (item.paused || item.startedAt === undefined) return [];
      const delay = Math.max(0, item.remainingMs - (now - item.startedAt));
      return [window.setTimeout(() => dismiss(item.id), delay)];
    });
    return () => timers.forEach((timer) => window.clearTimeout(timer));
  }, [dismiss, items]);

  const controller = useMemo<ErrorToastController>(() => ({ push, clear }), [clear, push]);
  const activeModal = modals.at(-1);
  const renderToast = (restoreFocus?: () => void) => (
    <Toast
      items={items.slice(0, MAX_VISIBLE_TOASTS)}
      announcement={announcement}
      onDismiss={dismiss}
      restoreFocus={restoreFocus}
      onExpandedChange={setExpanded}
      onPauseChange={setPaused}
    />
  );
  return (
    <ErrorToastContext.Provider value={controller}>
      <ErrorToastModalContext.Provider value={{ registerModal, activeModal, renderToast }}>
        {children}
        {activeModal ? null : renderToast()}
      </ErrorToastModalContext.Provider>
    </ErrorToastContext.Provider>
  );
}

function updateTiming(
  item: ManagedToast,
  pausedBy: ManagedToast["pausedBy"],
  nextPaused: boolean,
  patch: Partial<ManagedToast> = {},
): ManagedToast {
  const now = Date.now();
  if (!item.paused && nextPaused) {
    const elapsed = item.startedAt === undefined ? 0 : now - item.startedAt;
    return { ...item, ...patch, pausedBy, paused: true, remainingMs: Math.max(0, item.remainingMs - elapsed), startedAt: undefined };
  }
  if (item.paused && !nextPaused) {
    return { ...item, ...patch, pausedBy, paused: false, startedAt: now };
  }
  return { ...item, ...patch, pausedBy, paused: nextPaused };
}

/** 获取全局错误提示控制器。 */
export function useErrorToast(): ErrorToastController {
  const controller = useContext(ErrorToastContext);
  if (!controller) throw new Error("useErrorToast 必须在 ErrorToastProvider 内使用");
  return controller;
}
