import { randomUUID } from "node:crypto";
import { cp, mkdir, readFile, readdir, realpath, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

import type {
  AgentProfile,
  AgentProfileDocument,
  CreateAgentInput,
  UpdateAgentInput,
} from "../../shared/agent-contracts";
import { normalizeTtsCustomParameters, readTtsCustomParameters } from "../../shared/tts-custom-parameters";
import type { DataPaths } from "../paths";
import { DomainError } from "../core/errors";
import { KeyedMutex } from "../core/keyed-mutex";
import { openDatabase } from "../database/database";
import { runMigrations } from "../database/migrator";
import { createAgentProfile, normalizeTitleGeneration, normalizeTtsVoice } from "./agent-profile";
import {
  createAgentRepository,
  type AgentRepository,
  type PersistedAgentDocument,
  type PersistedAgentProfile,
} from "./agent-repository";
import { AgentWorkspaceError, pathExists, preparePiMigration, resolveAgentWorkspace } from "./agent-workspace";
import { AgentPromptStore } from "./agent-prompt-store";

/**
 * Agent 删除选项。
 */
export interface RemoveAgentOptions {
  removeSessions: boolean;
  removeWorkspace: boolean;
}

/**
 * Agent 删除结果。
 */
export interface RemoveAgentResult {
  trashPath?: string;
}

/**
 * Agent 克隆选项。
 */
export interface CloneAgentOptions {
  name?: string;
  copyWorkspace?: boolean;
}

/**
 * AgentStore 的外部 Session 清理依赖。
 */
export interface AgentStoreDependencies {
  stageSessions?: (agentId: string) => Promise<{ commit(): Promise<void>; rollback(): Promise<void> }>;
  /** 生产环境把 Agent 全部跨存储文件纳入同一 durable 删除清单。 */
  stageRemoval?: (agentId: string, profile: AgentProfile, options: RemoveAgentOptions) => Promise<{ commit(): Promise<void>; rollback(): Promise<void> }>;
}

/**
 * 判断目标是否位于根目录内部。
 *
 * @param root 根目录
 * @param target 目标路径
 */
function isWithin(root: string, target: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

/**
 * 检查目录树中的符号链接不会指向源工作目录之外。
 *
 * @param sourceRoot 源工作目录真实路径
 * @param current 当前遍历目录
 */
async function validateWorkspaceLinks(sourceRoot: string, current: string): Promise<void> {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const path = join(current, entry.name);
    if (entry.isSymbolicLink()) {
      const target = await realpath(path);
      if (!isWithin(sourceRoot, target)) {
        throw new Error("工作目录包含越界符号链接，无法复制");
      }
    } else if (entry.isDirectory()) {
      await validateWorkspaceLinks(sourceRoot, path);
    }
  }
}

/**
 * 管理独立 Profile 与固定工作目录的 Agent 仓库。
 */
export class AgentStore {
  private readonly paths: DataPaths;
  private readonly dependencies: AgentStoreDependencies;
  private readonly prompts: AgentPromptStore;
  private readonly repository: AgentRepository;
  private readonly workspaceMutations = new KeyedMutex();

  /**
   * 创建 Agent 仓库。
   *
   * @param paths 持久化数据路径
   * @param dependencies Session 清理等外部依赖
   */
  constructor(
    paths: DataPaths,
    dependencies: AgentStoreDependencies = {},
    repository: AgentRepository = createDefaultRepository(paths),
  ) {
    this.paths = paths;
    this.dependencies = dependencies;
    this.prompts = new AgentPromptStore(paths.agentsDir);
    this.repository = repository;
  }

  /**
   * 列出所有有效 Agent Profile。
   */
  async list(): Promise<AgentProfileDocument[]> {
    return Promise.all((await this.repository.list()).map((document) => this.withInstructions(document)));
  }

  /**
   * 为历史 Profile 补齐原先由运行时无条件提供的系统工具。
   *
   * @param toolNames 需要补齐的系统工具名称
   */
  async ensureSystemToolPermissions(toolNames: string[]): Promise<void> {
    const required = [...new Set(toolNames)];
    if (required.length === 0) return;
    for (const current of await this.list()) {
      const missing = required.filter((toolName) => !current.profile.allowedTools.includes(toolName));
      if (missing.length === 0) continue;
      const next: AgentProfile = {
        ...current.profile,
        allowedTools: [...current.profile.allowedTools, ...missing],
        updatedAt: new Date().toISOString(),
      };
      const { instructions: _instructions, ...persisted } = next;
      await this.repository.update(current.profile.id, current.revision, persisted);
    }
  }

  /**
   * 幂等移除已经退役的工具权限，不改变其他权限及顺序。
   *
   * @param toolNames 需要精确移除的废弃工具名称
   */
  async removeToolPermissions(toolNames: readonly string[]): Promise<void> {
    const removed = new Set(toolNames);
    if (removed.size === 0) return;
    for (const current of await this.list()) {
      const allowedTools = current.profile.allowedTools.filter((name) => !removed.has(name));
      if (allowedTools.length === current.profile.allowedTools.length) continue;
      const next: AgentProfile = {
        ...current.profile,
        allowedTools,
        updatedAt: new Date().toISOString(),
      };
      const { instructions: _instructions, ...persisted } = next;
      await this.repository.update(current.profile.id, current.revision, persisted);
    }
  }

  /**
   * 保存 Agent 的展示顺序，并返回规范化后的完整列表。
   *
   * @param agentIds 用户指定的 Agent ID 顺序
   */
  async reorder(agentIds: string[]): Promise<AgentProfileDocument[]> {
    const profiles = await this.list();
    const knownIds = new Set(profiles.map(({ profile }) => profile.id));
    if (new Set(agentIds).size !== agentIds.length || agentIds.some((agentId) => !knownIds.has(agentId))) {
      throw new TypeError("Agent 排序包含无效 ID");
    }
    const requested = new Set(agentIds);
    const normalized = [
      ...agentIds,
      ...profiles.map(({ profile }) => profile.id).filter((agentId) => !requested.has(agentId)),
    ];
    await this.repository.reorder(normalized);
    return this.list();
  }

  /**
   * 读取单个 Agent Profile。
   *
   * @param agentId Agent 标识
   */
  async get(agentId: string): Promise<AgentProfileDocument | undefined> {
    this.assertAgentId(agentId);
    const loaded = await this.repository.findById(agentId);
    return loaded ? this.withInstructions(loaded) : undefined;
  }

  /**
   * 创建使用服务端 UUID 和独立 cwd 的 Agent。
   *
   * @param input 创建字段
   */
  async create(input: CreateAgentInput): Promise<AgentProfileDocument> {
    const id = randomUUID();
    const defaultCwd = join(this.paths.workspaceDir, "agents", id);
    const cwd = await resolveAgentWorkspace(this.paths.workspaceDir, input.cwd?.trim() || defaultCwd);
    return this.workspaceMutations.run("workspace-layout", async () => {
      await this.assertWorkspaceAvailable(cwd);
      const now = new Date().toISOString();
      const profile = createAgentProfile(id, cwd, input, now);
      const workspaceExisted = await pathExists(cwd);
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      try {
        await mkdir(this.agentDataDir(id), { recursive: true, mode: 0o700 });
        const { instructions: _instructions, ...storedProfile } = profile;
        await this.prompts.initializeNewAgent(id);
        const written = await this.repository.insert(storedProfile);
        return { profile, revision: written.revision };
      } catch (error) {
        await this.repository.remove(id).catch(() => undefined);
        await rm(this.agentDataDir(id), { recursive: true, force: true });
        if (!workspaceExisted) await rmdir(cwd).catch(() => undefined);
        throw error;
      }
    });
  }

  /**
   * 幂等创建兼容旧安装的默认 Agent。
   */
  async createDefault(): Promise<AgentProfileDocument> {
    const existing = await this.get("default");
    if (existing) {
      return existing;
    }
    return this.workspaceMutations.run("workspace-layout", async () => {
      const existingInside = await this.get("default");
      if (existingInside) return existingInside;
      const cwd = join(this.paths.workspaceDir, "agents", "default");
      await this.assertWorkspaceAvailable(cwd);
      const profile = createAgentProfile("default", cwd, { name: "默认 Agent" }, new Date().toISOString());
      const { instructions: _instructions, ...storedProfile } = profile;
      await mkdir(cwd, { recursive: true, mode: 0o700 });
      await mkdir(this.agentDataDir("default"), { recursive: true, mode: 0o700 });
      await this.prompts.initializeNewAgent("default");
      const written = await this.repository.insert(storedProfile);
      return { profile, revision: written.revision };
    });
  }

  /**
   * 更新可编辑字段，并在工作目录变化时迁移 `.pi`。
   *
   * @param agentId Agent 标识
   * @param patch 可编辑字段
   * @param revision 调用方版本
   */
  async update(agentId: string, patch: UpdateAgentInput, revision: string): Promise<AgentProfileDocument> {
    return this.workspaceMutations.run("workspace-layout", async () => {
    const current = await this.require(agentId);
    const name = patch.name?.trim() ?? current.profile.name;
    if (!name) {
      throw new TypeError("Agent 名称不能为空");
    }
    const requestedCwd = patch.cwd === undefined
      ? current.profile.cwd
      : await resolveAgentWorkspace(this.paths.workspaceDir, patch.cwd);
    await this.assertWorkspaceAvailable(requestedCwd, agentId);
    const migration = requestedCwd === current.profile.cwd
      ? undefined
      : await preparePiMigration(current.profile.cwd, requestedCwd);
    const { cwd: _cwd, defaultModel, defaultThinkingLevel, titleGeneration, ttsProfileId, ttsVoice, ttsCustomParameters, ttsAutoPlay, ttsStreamPlayback, ...safePatch } = patch;
    const next: AgentProfile = {
      ...current.profile,
      ...safePatch,
      name,
      avatar: patch.avatar ?? current.profile.avatar,
      instructions: current.profile.instructions,
      mediaLibraryGrants: patch.mediaLibraryGrants ?? current.profile.mediaLibraryGrants ?? [],
      allowedTools: patch.allowedTools ? [...patch.allowedTools] : current.profile.allowedTools,
      id: current.profile.id,
      cwd: requestedCwd,
      createdAt: current.profile.createdAt,
      updatedAt: new Date().toISOString(),
    };
    if (defaultModel === null) delete next.defaultModel;
    else if (defaultModel !== undefined) next.defaultModel = defaultModel;
    if (defaultThinkingLevel === null) delete next.defaultThinkingLevel;
    else if (defaultThinkingLevel !== undefined) next.defaultThinkingLevel = defaultThinkingLevel;
    if (titleGeneration === null) delete next.titleGeneration;
    else if (titleGeneration !== undefined) next.titleGeneration = normalizeTitleGeneration(titleGeneration);
    if (ttsProfileId === null) {
      delete next.ttsProfileId;
      delete next.ttsVoice;
      delete next.ttsCustomParameters;
      delete next.ttsAutoPlay;
      delete next.ttsStreamPlayback;
    } else if (ttsProfileId !== undefined) {
      next.ttsProfileId = ttsProfileId;
      next.ttsAutoPlay = ttsAutoPlay === true;
      next.ttsStreamPlayback = ttsAutoPlay === true && ttsStreamPlayback === true;
    }
    if (ttsProfileId !== null) {
      if (ttsVoice === null) delete next.ttsVoice;
      else if (ttsVoice !== undefined) {
        const normalizedVoice = normalizeTtsVoice(ttsVoice);
        if (normalizedVoice) next.ttsVoice = normalizedVoice;
        else delete next.ttsVoice;
      }
      if (ttsCustomParameters === null) delete next.ttsCustomParameters;
      else if (ttsCustomParameters !== undefined) {
        const normalizedParameters = normalizeTtsCustomParameters(ttsCustomParameters);
        if (Object.keys(normalizedParameters).length > 0) next.ttsCustomParameters = normalizedParameters;
        else delete next.ttsCustomParameters;
      }
    }
    if (!next.ttsProfileId) {
      delete next.ttsVoice;
      delete next.ttsCustomParameters;
    }
    const { instructions: _instructions, ...storedNext } = next;
    const written = await this.repository.update(agentId, revision, storedNext)
      .catch(async (error: unknown) => {
        await migration?.rollback();
        throw error;
      });
    await migration?.commit();
    return { profile: next, revision: written.revision };
    });
  }

  /**
   * 保存经过校验的本地头像，并用 Profile revision 保护并发更新。
   *
   * @param agentId Agent 标识
   * @param content 图片二进制
   * @param mediaType 已识别的图片类型
   * @param revision 调用方 Profile 版本
   */
  async setImageAvatar(
    agentId: string,
    content: Buffer,
    mediaType: "image/png" | "image/jpeg" | "image/webp",
    revision: string,
  ): Promise<AgentProfileDocument> {
    const current = await this.get(agentId);
    const token = randomUUID();
    const path = this.avatarPath(agentId, token);
    await writeFile(path, content, { mode: 0o600, flag: "wx" });
    try {
      const updated = await this.update(agentId, { avatar: { kind: "image", revision: token, mediaType } }, revision);
      if (current?.profile.avatar.kind === "image" && current.profile.avatar.revision !== token) {
        // Profile 已原子指向新文件，旧文件清理失败不应把成功更新误报为失败。
        await rm(this.avatarPath(agentId, current.profile.avatar.revision), { force: true }).catch(() => undefined);
      }
      return updated;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  /**
   * 读取当前 Profile 指向的头像文件。
   */
  async readImageAvatar(agentId: string): Promise<{ content: Buffer; mediaType: string } | undefined> {
    const current = await this.get(agentId);
    if (!current || current.profile.avatar.kind !== "image") return undefined;
    return {
      content: await readFile(this.avatarPath(agentId, current.profile.avatar.revision)),
      mediaType: current.profile.avatar.mediaType,
    };
  }

  /**
   * 归档 Agent。
   */
  async archive(agentId: string, revision: string): Promise<AgentProfileDocument> {
    return this.setStatus(agentId, "archived", revision);
  }

  /**
   * 恢复 Agent。
   */
  async restore(agentId: string, revision: string): Promise<AgentProfileDocument> {
    return this.setStatus(agentId, "active", revision);
  }

  /**
   * 校验 Agent 可以创建新的 Session。
   */
  async assertCanCreateSession(agentId: string): Promise<void> {
    const { profile } = await this.require(agentId);
    if (profile.status === "archived") {
      throw new DomainError("AGENT_ARCHIVED", "归档 Agent 不能创建新 Session");
    }
  }

  /**
   * 解析并校验 Agent 的固定工作目录。
   *
   * @param agentId Agent 标识
   */
  async resolveWorkspace(agentId: string): Promise<string> {
    const document = await this.get(agentId);
    if (!document) {
      throw new DomainError("AGENT_NOT_FOUND", "Agent 不存在");
    }
    const { profile } = document;
    if (!isAbsolute(profile.cwd)) {
      throw new Error("Agent 工作目录必须是绝对路径");
    }
    const resolvedCwd = await resolveAgentWorkspace(this.paths.workspaceDir, profile.cwd);
    await this.assertWorkspaceAvailable(resolvedCwd, agentId);
    return resolvedCwd;
  }

  /**
   * 克隆 Profile，并按需复制经过符号链接检查的工作目录。
   *
   * @param sourceAgentId 源 Agent 标识
   * @param options 克隆选项
   */
  async clone(sourceAgentId: string, options: CloneAgentOptions = {}): Promise<AgentProfileDocument> {
    const source = await this.require(sourceAgentId);
    const clone = await this.create({
      name: options.name ?? `${source.profile.name} 副本`,
      description: source.profile.description,
      avatar: source.profile.avatar.kind === "initial"
        ? source.profile.avatar
        : { kind: "initial", value: source.profile.name.slice(0, 1).toUpperCase() },
      defaultModel: source.profile.defaultModel,
      defaultThinkingLevel: source.profile.defaultThinkingLevel,
      titleGeneration: source.profile.titleGeneration,
      allowedTools: source.profile.allowedTools,
    });
    if (!options.copyWorkspace) {
      return clone;
    }
    try {
      const sourceRoot = await realpath(source.profile.cwd);
      await validateWorkspaceLinks(sourceRoot, sourceRoot);
      await cp(sourceRoot, clone.profile.cwd, { recursive: true, force: false, errorOnExist: false, verbatimSymlinks: true });
      return clone;
    } catch (error) {
      await this.repository.remove(clone.profile.id);
      await rm(this.agentDataDir(clone.profile.id), { recursive: true, force: true });
      await rm(clone.profile.cwd, { recursive: true, force: true });
      throw error;
    }
  }

  /**
   * 删除 Profile，并按独立选项清理 Session 和可恢复移动 cwd。
   *
   * @param agentId Agent 标识
   * @param options 删除选项
   */
  async remove(agentId: string, options: RemoveAgentOptions): Promise<RemoveAgentResult> {
    const current = await this.require(agentId);
    if (options.removeWorkspace) {
      // 历史或手工损坏 Profile 也不能让删除流程接触 workspace 专用根之外的系统目录。
      await resolveAgentWorkspace(this.paths.workspaceDir, current.profile.cwd);
    }
    const stagedRemoval = await this.dependencies.stageRemoval?.(agentId, current.profile, options);
    const stagedSessions = !stagedRemoval && options.removeSessions ? await this.dependencies.stageSessions?.(agentId) : undefined;
    let trashPath: string | undefined;
    let stagedAgentDataPath: string | undefined;
    try {
      if (!stagedRemoval && options.removeWorkspace) {
        const workspace = await this.resolveWorkspace(agentId);
        trashPath = join(this.paths.trashDir, "agents", `${Date.now()}-${agentId}-${randomUUID()}`);
        await mkdir(dirname(trashPath), { recursive: true, mode: 0o700 });
        await rename(workspace, trashPath);
      }
      const agentDataDirectory = this.agentDataDir(agentId);
      if (!stagedRemoval && await pathExists(agentDataDirectory)) {
        stagedAgentDataPath = join(this.paths.trashDir, "agent-data", `${Date.now()}-${agentId}-${randomUUID()}`);
        await mkdir(dirname(stagedAgentDataPath), { recursive: true, mode: 0o700 });
        await rename(agentDataDirectory, stagedAgentDataPath);
      }
      await this.repository.remove(agentId, options.removeSessions);
    } catch (error) {
      const rollbackResults = await Promise.allSettled([
        ...(stagedAgentDataPath ? [rename(stagedAgentDataPath, this.agentDataDir(agentId))] : []),
        ...(trashPath ? [rename(trashPath, current.profile.cwd)] : []),
        ...(stagedSessions ? [stagedSessions.rollback()] : []),
        ...(stagedRemoval ? [stagedRemoval.rollback()] : []),
      ]);
      if (rollbackResults.some((result) => result.status === "rejected")) {
        throw new DomainError("AGENT_DELETE_ROLLBACK_FAILED", "Agent 删除失败且关联文件恢复未完成", undefined, { cause: error });
      }
      throw error;
    }
    try {
      await stagedSessions?.commit();
      await stagedRemoval?.commit();
    } catch {
      // 数据库删除已经提交，回收区清理失败时保留可恢复副本，不把成功结果伪装成失败。
    }
    if (stagedAgentDataPath) {
      try {
        await rm(stagedAgentDataPath, { recursive: true, force: true });
      } catch {
        // Agent 已删除时保留回收区副本，避免清理失败改变已提交结果。
      }
    }
    return { trashPath };
  }

  private async require(agentId: string): Promise<AgentProfileDocument> {
    const document = await this.get(agentId);
    if (!document) {
      throw new DomainError("AGENT_NOT_FOUND", "Agent 不存在");
    }
    return document;
  }

  private async setStatus(
    agentId: string,
    status: AgentProfile["status"],
    revision: string,
  ): Promise<AgentProfileDocument> {
    const current = await this.require(agentId);
    const next = { ...current.profile, status, updatedAt: new Date().toISOString() };
    const { instructions: _instructions, ...storedNext } = next;
    const written = await this.repository.update(agentId, revision, storedNext);
    return { profile: next, revision: written.revision };
  }

  /**
   * 校验规范工作目录没有被其他 Agent 使用。
   *
   * @param candidate 已规范化的候选目录
   * @param excludedAgentId 更新时排除的 Agent 标识
   */
  private async assertWorkspaceAvailable(candidate: string, excludedAgentId?: string): Promise<void> {
    for (const { profile } of await this.list()) {
      if (profile.id === excludedAgentId) continue;
      const otherCwd = await resolveAgentWorkspace(this.paths.workspaceDir, profile.cwd);
      if (isWithin(otherCwd, candidate) || isWithin(candidate, otherCwd)) {
        throw new AgentWorkspaceError("WORKSPACE_IN_USE", `工作目录已被 Agent ${profile.id} 占用`);
      }
    }
  }

  private async withInstructions(document: PersistedAgentDocument): Promise<AgentProfileDocument> {
    const { ttsCustomParameters: storedTtsCustomParameters, ...storedProfile } = document.profile;
    const ttsCustomParameters = readTtsCustomParameters(storedTtsCustomParameters);
    return {
      profile: {
        ...storedProfile,
        ...(Object.keys(ttsCustomParameters).length > 0 ? { ttsCustomParameters } : {}),
        instructions: await this.prompts.readLongTermInstructions(document.profile.id),
      },
      revision: document.revision,
    };
  }

  private agentDataDir(agentId: string): string {
    return join(this.paths.agentsDir, agentId);
  }

  private avatarPath(agentId: string, revision: string): string {
    this.assertAgentId(agentId);
    if (!/^[a-f0-9-]+$/u.test(revision)) throw new TypeError("头像版本格式无效");
    return join(this.paths.agentsDir, agentId, `avatar-${revision}`);
  }

  private assertAgentId(agentId: string): void {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/u.test(agentId)) {
      throw new TypeError("Agent ID 格式无效");
    }
  }
}

function createDefaultRepository(paths: DataPaths): AgentRepository {
  const database = openDatabase(paths.databaseFile);
  runMigrations(database);
  return createAgentRepository(database);
}
