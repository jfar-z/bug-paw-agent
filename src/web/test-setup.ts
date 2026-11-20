import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// 每条用例结束后清理挂载节点，避免页面实例相互污染。
afterEach(() => {
  cleanup();
});

// JSDOM 不实现媒体查询，统一提供与浏览器接口一致的最小测试桩。
if (typeof window !== "undefined" && !window.matchMedia) {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      addListener: () => undefined,
      removeListener: () => undefined,
      dispatchEvent: () => false,
    }),
  });
}

// JSDOM 尚未实现原生模态层。测试桩仅维护 open 状态，焦点和遮罩另由浏览器验证。
if (typeof HTMLDialogElement !== "undefined" && !HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
    this.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")?.focus();
  };
  HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
}
