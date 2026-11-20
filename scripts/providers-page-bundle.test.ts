// @vitest-environment node
import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/** Provider 重组后的摘要与页签必须保持页面加载边界和主题继承。 */
describe("Provider 页面样式边界", () => {
  it("列表样式和共享弹层只随懒加载配置页面加载", async () => {
    const page = await readFile("src/web/pages/providers-page.tsx", "utf8");
    expect(page).toContain('import "../providers.css"');
    expect(page).toContain('from "../components/configuration/configuration-editor-dialog"');
    for (const file of ["src/web/main.tsx", "src/web/app.tsx", "src/web/styles.css"]) {
      const source = await readFile(file, "utf8");
      expect(source).not.toContain('import "./providers.css"');
      expect(source).not.toContain("configuration-editor-dialog.css");
      expect(source).not.toContain(".provider-summary");
    }
  });

  it("新增布局使用主题令牌且登记独立预算", async () => {
    const css = await readFile("src/web/providers.css", "utf8");
    expect(css).not.toMatch(/#[\da-f]{3,8}\b|rgba?\(/i);
    expect(css).toContain("@media (max-width: 760px)");
    const budget = JSON.parse(await readFile("config/bundle-budget.json", "utf8"));
    expect(budget.css.routes["src/web/pages/providers-page.tsx"].gzipBytes).toBe(7296);
  });
});
