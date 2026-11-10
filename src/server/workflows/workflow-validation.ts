import {
  WORKFLOW_NODE_NAMES,
  WORKFLOW_TYPES,
  workflowLoopOutputs,
  type WorkflowBinding,
  type WorkflowDraft,
  type WorkflowField,
  type WorkflowNode,
  type WorkflowCondition,
  type WorkflowNodeConfig,
} from "../../shared/workflow-contracts";
import { DomainError } from "../core/errors";

/** 字段名只支持安全标识符，避免原型属性与任意路径寻址。 */
export function validName(name: unknown): name is string {
  return (
    typeof name === "string" &&
    /^[A-Za-z_][A-Za-z0-9_]{0,79}$/.test(name) &&
    !["__proto__", "prototype", "constructor"].includes(name)
  );
}
/** 所有验证错误进入统一 HTTP 与运行错误出口。 */
export function invalid(message: string): never {
  throw new DomainError("VALIDATION_FAILED", message);
}
export function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
/** 限制可序列化数据大小及深度，避免输入与脚本结果耗尽内存。 */
export function checkValueSize(value: unknown, limit = 1_048_576): void {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > limit)
    invalid("工作流数据超过允许大小（单节点最多 1 MiB）");
  const visit = (v: unknown, depth: number) => {
    if (depth > 30) invalid("工作流数据嵌套不能超过 30 层");
    if (typeof v === "number" && !Number.isFinite(v))
      invalid("工作流数值必须为有限数");
    if (v && typeof v === "object")
      for (const [key, child] of Object.entries(v)) {
        if (["__proto__", "constructor", "prototype"].includes(key))
          invalid("工作流数据包含禁止的原型字段");
        visit(child, depth + 1);
      }
  };
  visit(value, 0);
}
export function checkFields(fields: WorkflowField[]): void {
  if (!Array.isArray(fields) || fields.length > 100)
    invalid("节点参数定义必须为最多 100 项的数组");
  const names = new Set<string>();
  for (const field of fields) {
    if (
      !field ||
      !validName(field.name) ||
      names.has(field.name) ||
      !WORKFLOW_TYPES.includes(field.type)
    )
      invalid("参数名必须唯一且合法，参数类型必须受支持");
    if (
      (field.multiple !== undefined && typeof field.multiple !== "boolean") ||
      (field.required !== undefined && typeof field.required !== "boolean") ||
      (field.description !== undefined && typeof field.description !== "string")
    )
      invalid("参数必填、数组标记或说明格式错误");
    if (
      field.enumValues !== undefined &&
      (field.type !== "string" ||
        !Array.isArray(field.enumValues) ||
        !field.enumValues.length ||
        field.enumValues.length > 1000 ||
        field.enumValues.some((v) => typeof v !== "string") ||
        new Set(field.enumValues).size !== field.enumValues.length)
    )
      invalid(`参数 ${field.name} 的枚举必须是非空、不重复的字符串选项`);
    if (
      field.enumSource !== undefined &&
      (!record(field.enumSource) ||
        !validName(field.enumSource.nodeId) ||
        typeof field.enumSource.field !== "string" ||
        !field.enumSource.field ||
        !(
          (typeof field.enumSource.interfaceId === "string" &&
            !!field.enumSource.interfaceId &&
            field.enumSource.workflowId === undefined && field.enumSource.loop === undefined) ||
          (typeof field.enumSource.workflowId === "string" &&
            !!field.enumSource.workflowId &&
            field.enumSource.interfaceId === undefined && field.enumSource.loop === undefined) ||
          (field.enumSource.loop === true && field.enumSource.interfaceId === undefined && field.enumSource.workflowId === undefined)
        ) ||
        !field.enumValues?.length)
    )
      invalid(`参数 ${field.name} 的枚举来源格式无效`);
    names.add(field.name);
    if (field.defaultValue !== undefined) checkField(field, field.defaultValue);
  }
}
/** 对输入与输出使用同一类型校验，0/false/空数组都不视为缺失。 */
export function checkField(field: WorkflowField, value: unknown): void {
  if (value === undefined || value === null) {
    if (field.required) invalid(`必填参数 ${field.name} 未提供`);
    return;
  }
  if (field.multiple) {
    if (!Array.isArray(value) || value.length > 100)
      invalid(`参数 ${field.name} 必须为最多 100 项的数组`);
    for (const entry of value)
      checkField({ ...field, multiple: false, required: true }, entry);
    return;
  }
  if (field.enumValues && !field.enumValues.some((option) => option === value))
    invalid(`参数 ${field.name} 不在枚举范围内`);
  let ok = false;
  switch (field.type) {
    case "string":
      ok = typeof value === "string";
      break;
    case "float":
      ok = typeof value === "number" && Number.isFinite(value);
      break;
    case "integer":
      ok = typeof value === "number" && Number.isSafeInteger(value);
      break;
    case "boolean":
      ok = typeof value === "boolean";
      break;
    case "object":
      ok = record(value);
      break;
    default:
      ok =
        record(value) &&
        typeof value.assetId === "string" &&
        typeof value.mediaType === "string" &&
        (field.type === "file" || value.mediaType.startsWith(`${field.type}/`));
  }
  if (!ok)
    invalid(
      `参数 ${field.name} 必须为 ${field.type}${field.multiple ? "[]" : ""}`,
    );
}
export function validateValues(
  fields: WorkflowField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  if (!record(values)) invalid("工作流参数必须为 JSON 对象");
  checkValueSize(values);
  for (const name of Object.keys(values))
    if (!fields.some((f) => f.name === name)) invalid(`未声明的参数：${name}`);
  const result: Record<string, unknown> = {};
  for (const field of fields) {
    const value =
      values[field.name] === undefined
        ? field.defaultValue
        : values[field.name];
    checkField(field, value);
    if (value !== undefined) result[field.name] = value;
  }
  return result;
}
/** 自定义超参仅覆盖生成参数，禁止篡改身份、路由、消息和工具边界。 */
export function checkCustomParameters(
  value: unknown,
): asserts value is Record<string, unknown> {
  if (!record(value)) invalid("大模型自定义超参必须为 JSON 对象");
  checkValueSize(value, 32_768);
  const reserved =
    /^(model|messages|input|instructions|system|tools|toolchoice|stream|streamoptions|apikey|baseurl|headers|authorization|signal|onpayload|fetch|url|endpoint|extraheaders|contents|systeminstruction|toolconfig|httpoptions|abortsignal|config)$/i;
  for (const key of Object.keys(value))
    if (reserved.test(key.replace(/[-_]/g, "")))
      invalid(`自定义超参禁止覆盖 ${key}`);
}
/** 保存草稿允许模型待配置；运行/发布必须检查全部执行配置。 */
export function validateWorkflow(
  value: WorkflowDraft,
  runnable = false,
  depth = 0,
): WorkflowNode[] {
  if (depth > 6) invalid("循环体嵌套不能超过 6 层");
  if (
    !record(value) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 100 ||
    typeof value.description !== "string" ||
    value.description.length > 4000 ||
    typeof value.published !== "boolean"
  )
    invalid("工作流名称、说明或发布状态不合法");
  if (value.editorSettings !== undefined && (
    !record(value.editorSettings) ||
    typeof value.editorSettings.snapToGrid !== "boolean" ||
    typeof value.editorSettings.snapToNodes !== "boolean" ||
    Object.keys(value.editorSettings).some((key) => !["snapToGrid", "snapToNodes"].includes(key))
  )) invalid("工作流画布设置必须包含布尔类型的网格吸附和节点对齐开关");
  checkValueSize(value, 524_288);
  if (
    !Array.isArray(value.nodes) ||
    value.nodes.length < 2 ||
    value.nodes.length > 100 ||
    !Array.isArray(value.edges) ||
    value.edges.length > 400
  )
    invalid("工作流必须包含 2 到 100 个节点，最多 400 条连线");
  const nodes = new Map<string, WorkflowNode>();
  for (const node of value.nodes) {
    if (
      !node ||
      !validName(node.id) ||
      nodes.has(node.id) ||
      !Object.hasOwn(WORKFLOW_NODE_NAMES, node.kind) ||
      typeof node.name !== "string" ||
      node.name.length > 100 ||
      !record(node.inputs) ||
      !record(node.config) ||
      !record(node.position) ||
      !Number.isFinite(node.position.x) ||
      !Number.isFinite(node.position.y)
    )
      invalid("工作流节点标识、名称、配置或坐标不合法");
    nodes.set(node.id, node);
    checkFields(node.outputs);
    const config = node.config as WorkflowNodeConfig;
    if (node.kind === "semaphore_acquire" || node.kind === "semaphore_release") {
      if (runnable && !config.semaphoreCode) invalid(`节点 ${node.name} 尚未选择信号量`);
      if (config.semaphoreCode !== undefined && (typeof config.semaphoreCode !== "string" || !/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(config.semaphoreCode))) invalid("信号量 code 格式无效");
      if (Object.keys(node.inputs).length !== 1 || !node.inputs.count || node.outputs.length) invalid("信号量节点必须仅配置 count 输入且不声明输出");
      if (node.inputs.count.kind === "literal" && (!Number.isSafeInteger(node.inputs.count.value) || Number(node.inputs.count.value) < 1)) invalid("信号量数量必须为正整数");
    }
    if (node.kind === "workflow" && runnable && !config.workflowId)
      invalid(`节点 ${node.name} 尚未选择工作流`);
    if (node.kind === "loop") {
      const loop = config.loop;
      if (
        !record(loop) ||
        !record(loop.count) ||
        !record(loop.items) ||
        !record(loop.condition) ||
        !record(loop.condition.left) ||
        !record(loop.condition.right) ||
        !["count", "array", "while"].includes(loop.mode) ||
        !Number.isInteger(loop.maxIterations) ||
        loop.maxIterations < 1 ||
        loop.maxIterations > 100 ||
        !record(loop.state) ||
        !record(loop.outputs)
      )
        invalid(`循环 ${node.name} 配置无效，最大迭代次数必须为 1 到 100`);
      validateWorkflow(loop.body, runnable, depth + 1);
      const input = loop.body.nodes.find((n) => n.kind === "input")!;
      const output = loop.body.nodes.find((n) => n.kind === "output")!;
      if (
        !input.outputs.some(
          (f) => f.name === "index" && f.type === "integer" && !f.multiple,
        )
      )
        invalid(`循环 ${node.name} 的输入必须声明 integer 类型的 index`);
      if (
        loop.mode === "array" &&
        !input.outputs.some((f) => f.name === "item")
      )
        invalid(`数组循环 ${node.name} 的输入必须声明 item 类型`);
      for (const [name, state] of Object.entries(loop.state)) {
        const field = input.outputs.find((f) => f.name === name);
        const source =
          record(state) && output.outputs.find((f) => f.name === state.output);
        if (
          !validName(name) ||
          ["index", "item"].includes(name) ||
          !field ||
          !source ||
          !workflowFieldsCompatible(source, field) ||
          Object.hasOwn(node.inputs, name)
        )
          invalid(`循环 ${node.name} 的变量 ${name} 输入、更新来源或类型无效`);
      }
      for (const name of Object.keys(node.inputs)) {
        if (["index", "item"].includes(name))
          invalid(
            `循环 ${node.name} 的入参 ${name} 由循环自动提供，不能设置外部映射`,
          );
        if (!input.outputs.some((field) => field.name === name))
          invalid(
            `循环 ${node.name} 的入参映射 ${name} 未在循环体输入中声明，请删除旧映射或重新声明参数`,
          );
      }
      for (const [name, mapping] of Object.entries(loop.outputs)) {
        const source =
          record(mapping) &&
          output.outputs.find((f) => f.name === mapping.field);
        if (
          !validName(name) ||
          !source ||
          !["collect", "flatten", "last"].includes(mapping.mode) ||
          (mapping.mode === "collect" && source.multiple) ||
          (mapping.mode === "flatten" && !source.multiple)
        )
          invalid(
            `循环 ${node.name} 输出 ${name} 的来源或汇总方式与类型不兼容`,
          );
      }
      const expected = workflowLoopOutputs(loop);
      if (
        expected.length !== node.outputs.length ||
        expected.some(
          (field) =>
            !node.outputs.some(
              (f) =>
                f.name === field.name &&
                workflowFieldsCompatible(f, field) &&
                workflowFieldsCompatible(field, f) &&
                !!f.required === !!field.required &&
                JSON.stringify(f.enumValues ?? []) ===
                  JSON.stringify(field.enumValues ?? []),
            ),
        )
      )
        invalid(`循环 ${node.name} 输出定义与映射不一致，请同步循环输出`);
    }
    for (const key of [
      "provider",
      "modelId",
      "systemPrompt",
      "agentId",
      "sessionId",
      "interfaceId",
      "workflowId",
    ] as const)
      if (config[key] !== undefined && typeof config[key] !== "string")
        invalid(`节点配置 ${key} 必须为字符串`);
    if (
      config.archiveAfterCompletion !== undefined &&
      typeof config.archiveAfterCompletion !== "boolean"
    )
      invalid("归档选项必须为布尔值");
    const expected =
      node.kind === "llm"
        ? [{ name: "text", type: "string" }]
        : node.kind === "condition"
          ? [{ name: "result", type: "boolean" }]
          : node.kind === "agent"
            ? [
                { name: "text", type: "string" },
                { name: "files", type: "file", multiple: true },
                { name: "sessionId", type: "string" },
              ]
            : undefined;
    if (
      expected &&
      (node.outputs.length !== expected.length ||
        expected.some(
          (f) =>
            !node.outputs.some(
              (o) =>
                o.name === f.name &&
                o.type === f.type &&
                !!o.multiple === !!("multiple" in f && f.multiple),
            ),
        ))
    )
      invalid(`节点 ${node.name} 的固定输出定义不能修改`);
    if (node.kind === "select" && node.outputs.length !== 1)
      invalid("选择节点必须声明一个输出参数");
    if (node.kind === "llm") {
      checkCustomParameters(config.customParameters ?? {});
      for (const [key, min, max] of [
        ["temperature", 0, 2],
        ["topP", 0, 1],
        ["maxTokens", 1, 1_000_000],
        ["frequencyPenalty", -2, 2],
        ["presencePenalty", -2, 2],
      ] as const) {
        const n = config[key];
        if (
          n !== undefined &&
          (typeof n !== "number" ||
            !Number.isFinite(n) ||
            n < min ||
            n > max ||
            (key === "maxTokens" && !Number.isInteger(n)))
        )
          invalid(`大模型参数 ${key} 超出范围`);
      }
      if (
        config.thinking &&
        ![
          "inherit",
          "off",
          "minimal",
          "low",
          "medium",
          "high",
          "xhigh",
        ].includes(config.thinking)
      )
        invalid("思考等级不受支持");
    }
    if (
      node.kind === "javascript" &&
      (typeof config.script !== "string" ||
        config.script.length > 65_536 ||
        !Number.isInteger(config.timeoutMs) ||
        config.timeoutMs! < 100 ||
        config.timeoutMs! > 5000)
    )
      invalid("JS 节点代码最多 64 KiB，超时必须为 100 到 5000 毫秒整数");
    if (
      runnable &&
      node.kind === "llm" &&
      (!config.provider || !config.modelId)
    )
      invalid(`节点 ${node.name} 尚未选择模型`);
    if (
      runnable &&
      node.kind === "agent" &&
      (!config.agentId ||
        !["new", "fixed"].includes(config.sessionMode ?? "") ||
        (config.sessionMode === "fixed" && !config.sessionId))
    )
      invalid(`节点 ${node.name} 尚未配置 Agent 或目标会话`);
    if (runnable && node.kind === "aigc" && !config.interfaceId)
      invalid(`节点 ${node.name} 尚未选择 AIGC 接口`);
  }
  const starts = value.nodes.filter((n) => n.kind === "input"),
    ends = value.nodes.filter((n) => n.kind === "output");
  if (starts.length !== 1 || ends.length !== 1)
    invalid("工作流必须且只能包含一个输入节点和一个输出节点");
  const indegree = new Map(value.nodes.map((n) => [n.id, 0])),
    incoming = new Map(value.nodes.map((n) => [n.id, [] as string[]]));
  const edgeIds = new Set<string>();
  for (const edge of value.edges) {
    const a = nodes.get(edge.source),
      b = nodes.get(edge.target);
    if (
      !a ||
      !b ||
      a === b ||
      edgeIds.has(edge.id) ||
      !edge.id ||
      b.kind === "input" ||
      a.kind === "output"
    )
      invalid("工作流包含无效或重复连线");
    if (
      a.kind === "condition"
        ? !["true", "false"].includes(edge.branch ?? "")
        : edge.branch !== undefined
    )
      invalid("仅判断节点的连线必须指定 true/false 分支");
    edgeIds.add(edge.id);
    indegree.set(b.id, indegree.get(b.id)! + 1);
    incoming.get(b.id)!.push(a.id);
  }
  const queue = value.nodes.filter((n) => indegree.get(n.id) === 0),
    sorted: WorkflowNode[] = [];
  while (queue.length) {
    const node = queue.shift()!;
    sorted.push(node);
    for (const edge of value.edges.filter((e) => e.source === node.id)) {
      const degree = indegree.get(edge.target)! - 1;
      indegree.set(edge.target, degree);
      if (degree === 0) queue.push(nodes.get(edge.target)!);
    }
  }
  if (sorted.length !== value.nodes.length)
    invalid("工作流包含环路，请移除循环连线");
  const ancestors = new Map<string, Set<string>>();
  for (const node of sorted) {
    const set = new Set<string>();
    for (const parent of incoming.get(node.id)!) {
      set.add(parent);
      for (const ancestor of ancestors.get(parent) ?? []) set.add(ancestor);
    }
    ancestors.set(node.id, set);
    if (runnable && node.kind !== "input" && !set.has(starts[0].id))
      invalid(`节点 ${node.name} 未连接输入节点`);
  }
  const checkBinding = (binding: WorkflowBinding, node: WorkflowNode) => {
    if (!record(binding)) invalid(`节点 ${node.name} 参数绑定格式无效`);
    if (binding.kind === "literal") {
      checkValueSize(binding.value);
      return;
    }
    if (
      binding.kind !== "reference" ||
      !validName(binding.field) ||
      !nodes
        .get(binding.nodeId)
        ?.outputs.some((f) => f.name === binding.field) ||
      !ancestors.get(node.id)?.has(binding.nodeId)
    )
      invalid(`节点 ${node.name} 引用了不存在或非上游的输出`);
  };
  const checkCondition = (c: WorkflowCondition, n: WorkflowNode) => {
    if (
      !record(c) ||
      ![
        "eq",
        "ne",
        "gt",
        "gte",
        "lt",
        "lte",
        "contains",
        "empty",
        "not_empty",
      ].includes(c.operator)
    )
      invalid(`节点 ${n.name} 条件运算符无效`);
    checkBinding(c.left, n);
    checkBinding(c.right, n);
  };
  for (const node of value.nodes) {
    const config = node.config as WorkflowNodeConfig;
    for (const [name, b] of Object.entries(node.inputs)) {
      if (!validName(name)) invalid("输入映射名称不合法");
      // 输出节点直接透传绑定值，必须在保存和启动前拒绝已删除声明的旧映射。
      if (node.kind === "output" && !node.outputs.some((field) => field.name === name))
        invalid(`节点 ${node.name} 的输出绑定 ${name} 未声明，请在输出节点清理旧绑定`);
      checkBinding(b, node);
    }
    if (config.referenceGroups !== undefined) {
      if (
        node.kind !== "aigc" ||
        !record(config.referenceGroups) ||
        Object.keys(config.referenceGroups).length > 100
      )
        invalid("参考组数组配置只适用于 AIGC 节点，最多 100 组");
      for (const group of Object.values(config.referenceGroups)) {
        if (!record(group) || group.mode !== "array")
          invalid("参考组输入模式无效");
        if (group.binding) checkBinding(group.binding, node);
      }
    }
    if (node.kind === "loop") {
      const loop = config.loop!;
      if (loop.mode === "count") {
        checkBinding(loop.count, node);
        if (
          loop.count.kind === "literal" &&
          (!Number.isInteger(loop.count.value) ||
            Number(loop.count.value) < 0 ||
            Number(loop.count.value) > loop.maxIterations)
        )
          invalid(`循环 ${node.name} 次数必须为不超过最大迭代次数的非负整数`);
      }
      const input = loop.body.nodes.find((n) => n.kind === "input")!;
      const typedBinding = (
        binding: WorkflowBinding,
        field: import("../../shared/workflow-contracts").WorkflowField,
      ) => {
        checkBinding(binding, node);
        if (binding.kind === "literal") checkField(field, binding.value);
        else {
          const source = nodes
            .get(binding.nodeId)!
            .outputs.find((f) => f.name === binding.field)!;
          if (!workflowFieldsCompatible(source, field))
            invalid(`循环 ${node.name} 参数 ${field.name} 与上游类型不兼容`);
        }
      };
      if (loop.mode === "count")
        typedBinding(loop.count, {
          name: "count",
          type: "integer",
          required: true,
        });
      if (loop.mode === "array") {
        const item = input.outputs.find((field) => field.name === "item")!;
        if (item.multiple) invalid(`循环 ${node.name} 的 item 必须为单值类型`);
        typedBinding(loop.items, { ...item, multiple: true, required: true });
      }
      for (const [name, state] of Object.entries(loop.state))
        typedBinding(
          state.initial,
          input.outputs.find((field) => field.name === name)!,
        );
      for (const [name, binding] of Object.entries(node.inputs))
        typedBinding(
          binding,
          input.outputs.find((field) => field.name === name)!,
        );
      if (loop.mode === "while") {
        const condition = loop.condition;
        if (
          !record(condition) ||
          ![
            "eq",
            "ne",
            "gt",
            "gte",
            "lt",
            "lte",
            "contains",
            "empty",
            "not_empty",
          ].includes(condition.operator)
        )
          invalid(`循环 ${node.name} 的 while 条件运算符无效`);
        for (const binding of [condition.left, condition.right]) {
          if (
            !record(binding) ||
            (binding.kind !== "literal" &&
              (binding.kind !== "reference" ||
                binding.nodeId !== input.id ||
                !input.outputs.some((field) => field.name === binding.field)))
          )
            invalid(`循环 ${node.name} 的 while 条件只能引用循环输入或变量`);
          if (binding.kind === "literal") checkValueSize(binding.value);
        }
      }
    }
    for (const field of node.outputs) {
      if (!field.enumSource) continue;
      const source = nodes.get(field.enumSource.nodeId);
      if (field.enumSource.loop === true) {
        const options = source?.kind === "loop"
          ? source.config.loop?.body.nodes.find((item) => item.kind === "input")
              ?.outputs.find((item) => item.name === field.enumSource!.field)?.enumValues
          : undefined;
        // 循环入参来自内部输入声明，保存与运行都拒绝已经变化的枚举契约。
        if (!options?.length || options.length !== field.enumValues?.length ||
          options.some((option) => !field.enumValues!.includes(option)))
          invalid(`参数 ${field.name} 的循环枚举入参已变更，请重新选择枚举来源`);
      } else if (field.enumSource.workflowId !== undefined) {
        if (
          source?.kind !== "workflow" ||
          source.config.workflowId !== field.enumSource.workflowId
        )
          invalid(`参数 ${field.name} 的枚举来源工作流节点或调用目标已变更，请重新选择`);
      } else if (
        source?.kind !== "aigc" ||
        source.config.interfaceId !== field.enumSource.interfaceId
      )
        invalid(`参数 ${field.name} 的枚举来源节点或接口已变更，请重新选择`);
      // 类型可以引用下游，但必须位于同一条连通链路；不加入执行依赖。
      const connected = new Set([node.id]);
      for (let i = 0; i < value.nodes.length; i++)
        for (const edge of value.edges)
          if (connected.has(edge.source) || connected.has(edge.target)) {
            connected.add(edge.source);
            connected.add(edge.target);
          }
      if (!source || !connected.has(source.id))
        invalid(`参数 ${field.name} 的枚举来源未连接当前节点`);
    }
    if (node.kind === "condition") {
      if (
        !Array.isArray(config.conditions) ||
        !config.conditions.length ||
        config.conditions.length > 20 ||
        !["all", "any"].includes(config.conditionMode ?? "all")
      )
        invalid("判断节点需要 1 到 20 个条件");
      config.conditions.forEach((c) => checkCondition(c, node));
    }
    if (node.kind === "select") {
      if (
        !["first_available", "condition"].includes(
          config.selectMode ?? "first_available",
        )
      )
        invalid("选择节点模式不受支持");
      if (!Array.isArray(config.candidates) || config.candidates.length > 100)
        invalid("选择节点候选值格式不合法");
      config.candidates.forEach((b) => checkBinding(b, node));
      if (config.selectMode === "condition") {
        if (!config.selectCondition || config.candidates.length !== 2)
          invalid("条件选择需要一个条件和两个候选值");
        checkCondition(config.selectCondition, node);
      }
      if (runnable && !config.candidates.length)
        invalid("选择节点至少需要一个候选值");
    }
  }
  if (runnable) {
    for (const node of value.nodes) {
      if (node.kind !== "output" && !ancestors.get(ends[0].id)?.has(node.id))
        invalid(`节点 ${node.name} 没有连接到输出节点`);
      if (["llm", "agent"].includes(node.kind) && !node.inputs.prompt)
        invalid(`节点 ${node.name} 需要绑定用户 prompt`);
      if (node.kind === "output")
        for (const field of node.outputs) {
          const binding = node.inputs[field.name];
          if (field.required && !binding)
            invalid(`输出参数 ${field.name} 尚未绑定`);
          if (binding?.kind === "literal") checkField(field, binding.value);
          if (binding?.kind === "reference") {
            const source = nodes
              .get(binding.nodeId)!
              .outputs.find((f) => f.name === binding.field)!;
            if (
              !!source.multiple !== !!field.multiple ||
              (source.type !== field.type &&
                !(field.type === "float" && source.type === "integer") &&
                !(
                  field.type === "file" &&
                  ["image", "video", "audio"].includes(source.type)
                ))
            )
              invalid(`输出参数 ${field.name} 与上游类型不兼容`);
          }
        }
    }
  }
  return sorted;
}

/** 输入允许整数提升为浮点数，以及受控媒体引用提升为通用文件。 */
export function workflowFieldsCompatible(
  source: import("../../shared/workflow-contracts").WorkflowField,
  target: import("../../shared/workflow-contracts").WorkflowField,
): boolean {
  return (
    !!source.multiple === !!target.multiple &&
    (source.type === target.type ||
      (source.type === "integer" && target.type === "float") ||
      (target.type === "file" &&
        ["image", "video", "audio"].includes(source.type)))
  );
}
