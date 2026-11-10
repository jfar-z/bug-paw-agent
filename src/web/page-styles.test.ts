// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** 保护配置目录与文件浏览器边界，避免重构样式回流首屏或删除工作区规则。 */
describe("资源页面样式加载边界", () => {
  it("资源配置样式只从懒加载页面进入，不加载文件浏览器整份 CSS", async () => {
    const [app, main, page] = await Promise.all(["src/web/app.tsx", "src/web/main.tsx", "src/web/pages/resources-page.tsx"].map((path) => readFile(path, "utf8")));
    expect(app).toContain('lazy(() => import("./pages/resources-page")');
    expect(page).toContain('import "../resource-catalog.css"');
    expect(page).not.toContain('import "../resources.css"');
    expect(main).not.toContain("resource-catalog.css");
    expect(app).not.toContain("resource-catalog.css");
  });
  it("文件浏览器仍保留独立空态、手机预览及快捷抽屉布局", async () => {
    const [page, css] = await Promise.all(["src/web/pages/workspace-resources-page.tsx", "src/web/resources.css"].map((path) => readFile(path, "utf8")));
    expect(page).toContain('import "../resources.css"');
    for (const selector of [".workspace-resources-page__empty-state", ".workspace-file-preview", ".quick-workspace-drawer", ".workspace-table-wrap"]) expect(css).toContain(selector);
    expect(css).not.toContain(".resource-grid");
  });
});

/** 四页维护样式不能回流应用壳，共享弹层仍按组件加载。 */
describe("配置维护页加载边界", () => {
  it("四页仅通过懒加载入口引入维护领域 CSS", async () => {
    const main = await readFile("src/web/main.tsx", "utf8");
    const app = await readFile("src/web/app.tsx", "utf8");
    expect(main).not.toContain("configuration-maintenance.css"); expect(app).not.toContain("configuration-maintenance.css");
    for (const page of ["browser-automation-page", "knowledge-retrieval-page", "configuration-operations-page", "configuration-overview-page"]) {
      expect(app).toContain(`lazy(() => import("./pages/${page}")`);
      expect(await readFile(`src/web/pages/${page}.tsx`, "utf8")).toContain('import "../configuration-maintenance.css"');
    }
  });
});

/** 身份二维码在服务端生成，安全页及其 CSS 不应进入首屏。 */
it("安全设置按页面加载且不扩大首屏样式依赖", async () => {
  const [app, main, page] = await Promise.all(["src/web/app.tsx", "src/web/main.tsx", "src/web/pages/security-page.tsx"].map((path) => readFile(path, "utf8")));
  expect(app).toContain('lazy(() => import("./pages/security-page")');
  expect(page).toContain('import "../security.css"');
  expect(app).not.toContain('import "./security.css"');
  expect(main).not.toContain("security.css");
  expect(page).not.toMatch(/localStorage|sessionStorage/);
});

/** 工作流直达时也须包含完整确认框样式，不能依赖先访问配置中心。 */
it("共享确认弹层自行加载布局和按钮样式，配置中心复用同一份定义", async () => {
  const [dialog, configuration, shared, main] = await Promise.all([
    "src/web/features/workflows/workflow-confirm.tsx", "src/web/configuration.css",
    "src/web/configuration-dialog.css", "src/web/main.tsx",
  ].map((path) => readFile(path, "utf8")));
  expect(dialog).toContain('import "../../configuration-dialog.css"');
  expect(configuration).toContain('@import "./configuration-dialog.css"');
  expect(main).not.toContain("configuration-dialog.css");
  for (const selector of [".configuration-dialog-backdrop", ".configuration-dialog {", ".provider-rename-dialog {", ".configuration-primary-action {", ".configuration-secondary-action {"]) {
    expect(shared).toContain(selector);
    expect(configuration).not.toContain(selector);
  }
});

/** 文件页按路由加载资源浏览器与目录样式，不扩大首屏依赖。 */
it("工作流文件管理具有独立懒加载和手机表格预览边界", async () => {
  const [app, main, page, css] = await Promise.all([
    "src/web/app.tsx", "src/web/main.tsx", "src/web/pages/workflow-files-page.tsx", "src/web/workflow-files.css",
  ].map((path) => readFile(path, "utf8")));
  expect(app).toContain('lazy(() => import("./pages/workflow-files-page")');
  expect(page).toContain('import "../workflow-files.css"');
  expect(main).not.toContain("workflow-files.css");
  expect(app).not.toContain('import "./workflow-files.css"');
  expect(css).toContain("overflow-x: auto");
  expect(css).toContain("max-height: none");
});

/** 信号量管理独立加载，不能把配置表单和业务样式加入首屏。 */
it("信号量管理具有独立懒加载与主题响应式边界", async () => {
  const [app, main, page, css] = await Promise.all([
    "src/web/app.tsx", "src/web/main.tsx", "src/web/pages/workflow-semaphores-page.tsx", "src/web/workflow-semaphores.css",
  ].map((path) => readFile(path, "utf8")));
  expect(app).toContain('lazy(() => import("./pages/workflow-semaphores-page")');
  expect(page).toContain('import "../workflow-semaphores.css"');
  expect(main).not.toContain("workflow-semaphores.css");
  expect(css).toContain("var(--panel)"); expect(css).toContain("max-width:760px");
});
