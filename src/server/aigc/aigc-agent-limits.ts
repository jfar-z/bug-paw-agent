/** AIGC 统一执行额度与 Agent 查询限流配置。 */
export interface AigcAgentLimits {
  /** 手动、Agent 和 MCP 同时实际执行的任务总上限。 */
  maxActiveTasks: number;
  /** 单个调用方同时实际执行的任务上限。 */
  maxActiveTasksPerAgent: number;
  /** 单个调用方一小时内允许实际启动的任务上限。 */
  maxHourlyTasksPerAgent: number;
  /** 单个 Agent 查询同一任务的最小间隔，单位为毫秒。 */
  queryIntervalMs: number;
}

/** 未通过环境变量覆盖时使用的生产默认限流。 */
export const DEFAULT_AIGC_AGENT_LIMITS: Readonly<AigcAgentLimits> = Object.freeze({
  maxActiveTasks: 20,
  maxActiveTasksPerAgent: 5,
  maxHourlyTasksPerAgent: 200,
  queryIntervalMs: 1_000,
});

/** 从部署环境读取 AIGC Agent 限流，非法配置直接阻止服务启动。 */
export function readAigcAgentLimits(
  env: Readonly<Record<string, string | undefined>>,
): AigcAgentLimits {
  return {
    maxActiveTasks: readPositiveInteger(env, "BUG_PAW_AIGC_AGENT_MAX_ACTIVE_TASKS", DEFAULT_AIGC_AGENT_LIMITS.maxActiveTasks),
    maxActiveTasksPerAgent: readPositiveInteger(env, "BUG_PAW_AIGC_AGENT_MAX_ACTIVE_TASKS_PER_AGENT", DEFAULT_AIGC_AGENT_LIMITS.maxActiveTasksPerAgent),
    maxHourlyTasksPerAgent: readPositiveInteger(env, "BUG_PAW_AIGC_AGENT_MAX_HOURLY_TASKS_PER_AGENT", DEFAULT_AIGC_AGENT_LIMITS.maxHourlyTasksPerAgent),
    queryIntervalMs: readPositiveInteger(env, "BUG_PAW_AIGC_AGENT_QUERY_INTERVAL_SECONDS", DEFAULT_AIGC_AGENT_LIMITS.queryIntervalMs / 1_000) * 1_000,
  };
}

/** 只接受无符号十进制正整数，避免单位或小数配置产生歧义。 */
function readPositiveInteger(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  defaultValue: number,
): number {
  const raw = env[name];
  if (raw === undefined || raw === "") return defaultValue;
  if (!/^[1-9]\d*$/u.test(raw)) throw new TypeError(`环境变量 ${name} 必须为正整数`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new TypeError(`环境变量 ${name} 超出安全整数范围`);
  return value;
}
