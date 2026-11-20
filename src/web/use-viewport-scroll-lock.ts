import { useLayoutEffect } from "react";

// 对话页、抽屉及其确认弹层共享锁，按挂载顺序以外的顺序关闭也能恢复原状态。
let activeLocks = 0;
let releaseViewport: (() => void) | undefined;

/**
 * 在全屏对话页生命周期内关闭浏览器根滚动，并在卸载时恢复原值。
 */
export function useViewportScrollLock(): void {
  useLayoutEffect(() => {
    if (activeLocks === 0) releaseViewport = lockViewport();
    activeLocks += 1;
    return () => {
      activeLocks -= 1;
      if (activeLocks !== 0) return;
      releaseViewport?.();
      releaseViewport = undefined;
    };
  }, []);
}

function lockViewport(): () => void {
  const root = document.documentElement;
  const body = document.body;
  const rootOverflow = root.style.overflow;
  const bodyOverflow = body.style.overflow;
  const viewportHeight = root.style.getPropertyValue("--app-viewport-height");
  const viewportHeightPriority = root.style.getPropertyPriority("--app-viewport-height");
  const viewport = window.visualViewport;
  /** 刷新后以浏览器实际可见区域为准，避免 Android PWA 将系统导航栏计入对话高度。 */
  const syncViewportHeight = () => {
    const height = viewport?.height ?? window.innerHeight;
    if (height > 0) root.style.setProperty("--app-viewport-height", `${Math.round(height)}px`);
  };

  root.style.overflow = "hidden";
  body.style.overflow = "hidden";
  syncViewportHeight();
  window.addEventListener("resize", syncViewportHeight);
  window.addEventListener("orientationchange", syncViewportHeight);
  window.addEventListener("pageshow", syncViewportHeight);
  viewport?.addEventListener("resize", syncViewportHeight);

  return () => {
    window.removeEventListener("resize", syncViewportHeight);
    window.removeEventListener("orientationchange", syncViewportHeight);
    window.removeEventListener("pageshow", syncViewportHeight);
    viewport?.removeEventListener("resize", syncViewportHeight);
    root.style.overflow = rootOverflow;
    body.style.overflow = bodyOverflow;
    if (viewportHeight) {
      root.style.setProperty("--app-viewport-height", viewportHeight, viewportHeightPriority);
    } else {
      root.style.removeProperty("--app-viewport-height");
    }
  };
}
