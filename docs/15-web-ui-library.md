# 工作台 UI 组件使用规范

业务页面可以从 `src/web/ui/` 引用公共组件。页面持有路由、表单值、已选文件与批量选择集合，组件通过回调报告交互。控件需要独立加载时可直接从对应模块导入。

## 尺寸与主题

`ui/tokens.css` 统一提供 40px 常规高度、32px 紧凑高度、44px 触控目标、10px 控件圆角、12px 面板圆角、20px 标准图标与 16px 紧凑图标。间距为 4、8、12、16、24px。颜色继承工作台三套主题。焦点环使用 2px 轮廓和 2px 偏移。视觉规格变更需要同步评审和更新令牌。组件根、子元素、变体使用 `bp-` BEM 类名。页面定制使用根节点或规格变量。组件文件导入所属样式，入口只导出 API。

## 主要调用约定

| 场景 | 组件与行为 |
| --- | --- |
| 操作与输入 | Button、IconButton、FormField、TextField、Textarea、NumberField、Checkbox、Radio、Switch。IconButton 必须提供操作名称，FormField 的子函数将标签与错误说明的属性传给输入框。 |
| 菜单与模态 | Menu 提供方向键、Home、End 和 Escape。ConfirmDialog 支持 requireText 和 busy，调用方负责成功或取消后的关闭。Dialog 负责模态焦点与滚动锁定。 |
| 文件字段 | 每个来源有稳定的 id，回传文件 id、name、ref。限制媒体类型或大小时，来源提供真实 type、size 元数据。本地选择、拖入和粘贴共用校验。字段保持受控，删除来源后既有引用仍可显示和移除。 |
| 列表 | SelectableList 用稳定键保存选区。全选只影响可见结果，Shift 可选取连续范围，点击行内按钮独立执行操作。 |
| 导航 | WorkspaceLayout 由路由提供 hrefFor 和 onNavigate。移动抽屉支持 Escape、点击遮罩及焦点恢复。桌面沿用 56px 主轨和工作台二级栏宽度。 |
| 数据呈现 | Tabs、Pagination、StatusBadge、Progress、Skeleton、EmptyState 可组合成数据浏览页面。 |
| 专用界面 | 时间线、工作流画布和媒体编辑器可自行组织内容，并在通用操作、输入、菜单和模态层中引用组件库。 |

## 验证

检查键盘与触控操作、三主题对比度、选区保存和焦点恢复。新组件随其使用页面加载并计入现有页面预算。涉及懒加载边界和预算的调整遵循《Web 页面分包规范》。

## 样式与 API 边界

组件目录中的基础样式由对应模块导入。根节点使用 `bp-组件名`，子元素使用 `bp-组件名__元素`，静态变体使用 `bp-组件名--变体`。优先用原生属性及 ARIA 表达交互状态。页面定制使用根节点插槽或规格变量。业务页避免依赖内部 DOM 层级以及内部子元素类名。组件内部复用公共按钮、输入框、模态层和主题语义颜色。

同类交互跨页面出现时先复用组件或扩充其插槽。画布节点、媒体时间线、对话内容渲染等领域交互可以手写；其中的文件选择、确认、导航、表单和反馈应复用公共组件。新组件应覆盖键盘、粗指针、三主题、动态来源与忙碌状态。

| 接口 | 行为 |
| --- | --- |
| WorkspaceLayout | 通过 eyebrow 提供可见眉题，通过 hrefFor 提供可复制的真实地址。一级与二级抽屉互斥，桌面断点关闭抽屉。 |
| Dialog / ConfirmDialog | drawer 可取 left 或 right。requireText、confirmDisabled、busy 分别约束确认文字、业务前置条件和执行中的重复操作。默认焦点在取消按钮。 |
| Menu / Popover | Menu 的 icon 可用作紧凑入口，选项支持 icon、danger 和 separatorBefore。Popover 承载任意非模态内容。 |
| FormField / SecretInput / KeyValueEditor | inherit 可设置来源标签、当前继承值和切换回调。键值编辑器支持配置占位和空态文字，操作中保留行标识。 |
| Section / Collapse / Thumbnail | 标题分区序号可选；收起后阻止焦点进入内部控件；资源地址变化后重新加载缩略图。 |
| Toast / useUnsavedChanges / UnsavedChangesBar | 全局错误由原有队列处理并保留详情与请求标识；路由离开前保存、放弃或继续编辑；保存栏由页面持有草稿。 |
| Table / FilterChips / SearchField / SegmentedControl | 排序、筛选与选择均由调用方持有。搜索框支持清除和可选快捷键，分段选择支持键盘选择。 |

狸花主题组件内的危险文字使用局部语义色以保证对比度，产品全局危险色沿用品牌取值。
