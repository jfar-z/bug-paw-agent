import { chooseOption } from "../test-select";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ApiTaskProvider } from "../api-task-provider";
import { ErrorToastProvider } from "../error-toast-provider";
import { AigcOutputsPage } from "./aigc-outputs-page";

/** 渲染带统一 API 与错误提示上下文的产物页面。 */
function renderPage() {
  return render(
    <ErrorToastProvider>
      <ApiTaskProvider onAuthenticationRequired={vi.fn()}>
        <AigcOutputsPage />
      </ApiTaskProvider>
    </ErrorToastProvider>,
  );
}

describe("AigcOutputsPage", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("按创建时间请求产物并在单张缩略图完成后立即展示", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => new Response(JSON.stringify({
      items: [{
        id: "asset-1",
        taskId: "task-1",
        name: "result.png",
        mediaType: "image/png",
        size: 128,
        createdAt: "2026-09-09T08:00:01.000Z",
        taskCreatedAt: "2026-09-09T08:00:00.000Z",
        interfaceName: "文生图",
        kind: "image",
      }],
      counts: { image: 1, video: 0, audio: 0, other: 0 },
      page: 1,
      pageSize: 24,
      total: 1,
      totalPages: 1,
    })));
    vi.stubGlobal("fetch", fetchMock);
    renderPage();

    const image = await screen.findByAltText("result.png");
    expect(screen.getByText("正在加载")).toBeInTheDocument();
    expect(image).not.toBeVisible();
    fireEvent.load(image);
    expect(image).toBeVisible();
    expect(screen.queryByText("正在加载")).not.toBeInTheDocument();

    chooseOption("产物创建时间排序", "asc");
    await waitFor(() => expect(fetchMock.mock.calls.some(([url]) => String(url).includes("sort=asc"))).toBe(true));
  });
});
