/** 运行模板只面向已登录的手动运行工作台。 */
export type RunTemplateDomain = "aigc" | "workflow";

export interface RunTemplateSummary {
  id: string;
  name: string;
  targetId: string;
  targetName: string;
}

export interface RunTemplateDraft {
  targetId: string;
  inputs: Record<string, unknown>;
  issues: { field: string; message: string }[];
  /** 保存时已清空的已知字段，新增加的字段仍使用当前默认值。 */
  clearedFields?: string[];
  count: 1;
}

export interface RunTemplateWrite {
  targetId: string;
  inputs: Record<string, unknown>;
}
