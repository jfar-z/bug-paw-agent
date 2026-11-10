import { WorkflowRepository } from "./workflows/workflow-repository";
import { WorkflowService } from "./workflows/workflow-service";
import { WorkflowFiles } from "./workflows/workflow-files";
import { WorkflowNodeExecutor } from "./workflows/workflow-executor";
import { WorkflowToolService, createWorkflowTools } from "./workflows/workflow-tools";
import { registerWorkflowRoutes } from "./routes/workflows";
import { toSafePublicMessage } from "./core/errors";
import { createVersionedJsonStore } from "./configuration/versioned-json-store";
import { PdfEvidenceService } from "./web-research/pdf-evidence-service";
import { SafeWebClient } from "./web-research/safe-web-client";
import cookie from "@fastify/cookie";
import multipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import { access, mkdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createDataPaths, type DataPaths } from "./paths";
import {
  createSdkPiRuntimeGateway,
  type PiRuntimeGateway,
} from "./pi-runtime";
import { registerAuthRoutes, createAuthService } from "./routes/auth";
import { registerChatRoutes } from "./routes/chat";
import { registerModelRoutes } from "./routes/models";
import { registerSessionRoutes } from "./routes/sessions";
import { registerSetupRoutes } from "./routes/setup";
import { registerStatusRoutes } from "./routes/status";
import { createWorkspaceFileService, DEFAULT_UPLOAD_LIMITS } from "./attachments";
import { registerAttachmentRoutes } from "./routes/attachments";
import { createDataFileService } from "./data-files";
import { registerDataFileRoutes } from "./routes/data-files";
import { createWorkspaceFileManager } from "./workspace-files";
import { registerWorkspaceFileRoutes } from "./routes/workspace-files";
import { registerAgentRoutes } from "./routes/agents";
import { createRunCheckpointStore } from "./runtime/checkpoint-store";
import { createSessionMetadataStore } from "./session-metadata";
import { createSessionBulkRepository } from "./sessions/session-bulk-repository";
import { createSessionBulkService } from "./sessions/session-bulk-service";
import { ConfigTransaction, recoverPendingTransactions } from "./configuration/config-transaction";
import { createAgentService } from "./agents/agent-service";
import { AgentPromptStore } from "./agents/agent-prompt-store";
import { createRuntimeCoordinator, type RuntimeCoordinator } from "./runtime-coordinator";
import { RuntimeSupervisor } from "./runtime/runtime-supervisor";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { AgentProfile } from "../shared/agent-contracts";
import { RETIRED_AGENT_TOOL_NAMES, STARTUP_ENFORCED_SYSTEM_TOOL_NAMES } from "../shared/tool-catalog";
import { resolveEffectiveRetrievalCapabilities } from "./agent-retrieval-capabilities";
import { ModelConfigService } from "./configuration/model-config-service";
import { CredentialService } from "./configuration/credential-service";
import { ProviderRenameService, recoverPendingProviderRenames } from "./configuration/provider-rename-service";
import { createProviderModelDiscovery } from "./provider-model-discovery";
import { registerProviderRoutes } from "./routes/providers";
import { registerConfigurationRoutes } from "./routes/configuration";
import { registerResourceRoutes } from "./routes/resources";
import { ResourceService, ResourceTaskManager } from "./resources/resource-service";
import { registerOriginProtection } from "./routes/origin-protection";
import { createScheduledTaskRepository } from "./scheduled-tasks/scheduled-task-repository";
import { createScheduledTaskService } from "./scheduled-tasks/scheduled-task-service";
import { registerScheduledTaskRoutes } from "./routes/scheduled-tasks";
import { ensureScheduledTaskSkill } from "./scheduled-tasks/global-skill";
import { createScheduledTasksTool } from "./scheduled-tasks/scheduled-task-tool";
import { ensureSkillCreatorGlobalSkill } from "./skills/skill-creator-global-skill";
import { ensureDeepResearchGlobalSkill } from "./skills/deep-research-global-skill";
import { WebResearchConfigService } from "./web-research/web-research-config-service";
import { EgressProfileRegistry } from "./web-research/egress-profile-registry";
import { ManagedSearchProviderRegistry } from "./web-research/managed-search-provider-registry";
import { WebResearchProviderManagementService } from "./web-research/web-research-provider-management-service";
import { createWebResearchService } from "./web-research/web-research-service";
import { createPdfReadTool, createWebResearchTool, createWebReadTool, createWebSearchTool } from "./web-research/web-research-tools";
import { registerWebResearchRoutes } from "./routes/web-research";
import { TtsConfigService } from "./tts/tts-config-service";
import { TtsSynthesisService } from "./tts/tts-synthesis-service";
import { registerTtsRoutes } from "./routes/tts";
import { WhisperClient } from "./asr/whisper-client";
import { registerSpeechRoutes } from "./routes/speech";
import { AigcConnectionService } from "./aigc/aigc-connection-service";
import { AigcConnectionManagementService } from "./aigc/aigc-connection-management-service";
import { AigcConnectionValidation } from "./aigc/aigc-connection-validation";
import { AigcWorkflowService } from "./aigc/aigc-workflow-service";
import { AigcInterfaceService } from "./aigc/aigc-interface-service";
import { AigcAssetService } from "./aigc/aigc-asset-service";
import { AigcPublicFileService } from "./aigc/aigc-public-file-service";
import { AigcComfyUiInputService } from "./aigc/aigc-comfyui-input-service";
import { AigcTaskRepository } from "./aigc/aigc-task-repository";
import { AigcTaskService } from "./aigc/aigc-task-service";
import { AigcAgentService } from "./aigc/aigc-agent-service";
import { readAigcAgentLimits } from "./aigc/aigc-agent-limits";
import { createAigcAgentTools } from "./aigc/aigc-agent-tools";
import { AigcMcpService } from "./aigc/aigc-mcp-service";
import { registerAigcMcpRoutes } from "./routes/aigc-mcp";
import { AigcMediaProjectService } from "./aigc/aigc-media-project-service";
import { OpenAiAigcAdapter } from "./aigc/openai-adapter";
import { GrokAigcAdapter } from "./aigc/grok-adapter";
import { ComfyUiAigcAdapter } from "./aigc/comfyui-adapter";
import { registerAigcChannelRoutes } from "./routes/aigc-channels";
import { registerAigcRoutes } from "./routes/aigc";
import { EmbeddingConfigService } from "./knowledge-base/embedding-config-service";
import { OpenAiEmbeddingClient } from "./knowledge-base/openai-embedding-client";
import { registerKnowledgeRetrievalRoutes } from "./routes/knowledge-retrieval";
import { createKnowledgeRepository } from "./knowledge-base/knowledge-repository";
import { createKnowledgeBaseService } from "./knowledge-base/knowledge-base-service";
import { registerKnowledgeBaseRoutes } from "./routes/knowledge-bases";
import { createKnowledgeManageTool, createKnowledgeReadTool, createKnowledgeSearchTool } from "./knowledge-base/knowledge-tools";
import { cleanupBundledRetrievalSkills } from "./retrieval/legacy-retrieval-skills";
import { createAgentReferenceResolver } from "./agent-references";
import { ComposerCatalogService } from "./composer-catalog";
import { registerComposerCatalogRoutes } from "./routes/composer-catalog";
import { openDatabase } from "./database/database";
import { runMigrations } from "./database/migrator";
import { createIdentityRepository } from "./identity/identity-repository";
import { createAgentRepository } from "./agents/agent-repository";
import { createSessionRepository } from "./sessions/session-repository";
import { hasPersistedSessionFile, reconcileUnpersistedSessions } from "./sessions/session-reconciliation";
import { acquireInstanceLock } from "./instance-lock";
import { createConfigurationHistoryRepository } from "./configuration/configuration-history-repository";
import { ChatApplicationService } from "./chat/chat-service";
import { resolveSessionAgentId } from "./session-agent";
import { registerApiV1Namespace } from "./http/api-versioning";
import { exposeRequestId, registerApiErrorHandler } from "./http/error-handler";
import { sendApiError } from "./routes/http";
import { BackgroundErrorRegistry } from "./observability/background-errors";
import { SYSTEM_LIMITS } from "./core/limits";
import { createSessionTextTools } from "./session-text-tools";
import { AgentLifecycleGate } from "./core/agent-lifecycle-gate";
import { DurableDeletionCoordinator } from "./core/durable-deletion";
import { KeyedMutex } from "./core/keyed-mutex";
import { readDeploymentCapabilities } from "./deployment-capabilities";
import { BrowserConfigService } from "./browser-automation/browser-config-service";
import { BrowserWorkerClient } from "./browser-automation/browser-worker-client";
import { BrowserResourcePool } from "./browser-automation/browser-resource-pool";
import { BrowserRunRegistry } from "./browser-automation/browser-run-registry";
import { BrowserPreviewService } from "./browser-automation/browser-preview-service";
import { BrowserAuditRepository } from "./browser-automation/browser-audit-repository";
import { BrowserAutomationService } from "./browser-automation/browser-automation-service";
import { createBrowserTools } from "./browser-automation/browser-tools";
import { SessionQuestionRepository } from "./questions/session-question-repository";
import { createAskUserTool } from "./questions/ask-user-tool";
import { SessionQuestionRuntimeState } from "./questions/session-question-reconciliation";
import { SessionQuestionService } from "./questions/session-question-service";
import { resolveBrowserCapabilities } from "./browser-automation/browser-capabilities";
import { registerBrowserAutomationRoutes } from "./routes/browser-automation";
import { registerBrowserPreviewRoutes } from "./routes/browser-preview";
import { AgentSystemPromptConfiguration } from "./agent-system-prompt-configuration";
import { BrowserArtifactService } from "./browser-automation/browser-artifact-service";

export interface BuildServerOptions {
  dataRoot?: string;
  staticRoot?: string;
  logger?: boolean;
  runtimeFactory?: (paths: DataPaths) => Promise<PiRuntimeGateway>;
}

/** 为 Agent 解析隔离的会话存储目录。 */
export function resolveAgentSessionDir(paths: DataPaths, agentId: string): string {
  // 所有 Agent（含 default）使用相同隔离规则，删除单个 Agent 时不会误伤其他会话目录。
  return resolve(paths.piDir, "sessions", agentId);
}

/**
 * 装配 HTTP、认证、pi SDK API 与前端静态资源。
 */
export async function buildServer(options: BuildServerOptions = {}): Promise<FastifyInstance> {
  const paths = await createDataPaths(options.dataRoot ?? process.env.PI_AGENT_DATA_ROOT ?? "/data");
  const deploymentCapabilities = readDeploymentCapabilities(process.env);
  const instanceLock = await acquireInstanceLock(paths.appDir);
  let database: ReturnType<typeof openDatabase> | undefined;
  try {
    database = openDatabase(paths.databaseFile);
    runMigrations(database);
    const applicationDatabase = database;
    const durableDeletions = new DurableDeletionCoordinator(paths.rootDir, paths.deletionTransactionDir, applicationDatabase);
    await durableDeletions.recover();
    await recoverPendingTransactions({ rootDir: paths.rootDir, transactionDir: paths.transactionDir });
    // 上传 staging 不属于业务事实源，启动时清理崩溃遗留的敏感临时资料。
    await rm(join(paths.knowledgeDir, "staging"), { recursive: true, force: true });
    await mkdir(join(paths.knowledgeDir, "staging"), { recursive: true, mode: 0o700 });
    const staticRoot = resolve(options.staticRoot ?? "dist/web");
    await access(staticRoot);

  const app = Fastify({ logger: options.logger ?? false });
  const backgroundErrors = new BackgroundErrorRegistry();
  registerApiV1Namespace(app);
  registerApiErrorHandler(app);
  await app.register(cookie);
  await app.register(multipart, {
    limits: { files: DEFAULT_UPLOAD_LIMITS.maxFiles, fileSize: DEFAULT_UPLOAD_LIMITS.maxFileSize },
  });
  const identities = createIdentityRepository(applicationDatabase);
  const authService = createAuthService(paths, { identityRepository: identities });
  registerOriginProtection(app);
  const sessionRepository = createSessionRepository(applicationDatabase);
  const sessionQuestions = new SessionQuestionRepository(applicationDatabase);
  const questionRuntimeStates = new Map<string, SessionQuestionRuntimeState>();
  const questionStateFor = (agentId: string) => {
    const existing = questionRuntimeStates.get(agentId);
    if (existing) return existing;
    const created = new SessionQuestionRuntimeState(agentId, sessionQuestions);
    questionRuntimeStates.set(agentId, created);
    return created;
  };
  const questionService = new SessionQuestionService(sessionQuestions, questionStateFor);
  const sessionBulkRepository = createSessionBulkRepository(applicationDatabase);
  await reconcileUnpersistedSessions(paths, applicationDatabase);
  const agentLifecycle = new AgentLifecycleGate();
  const modelMutations = new KeyedMutex();
  const sessionMetadataStore = createSessionMetadataStore(sessionRepository);
  const scheduledTaskStore = createScheduledTaskRepository(applicationDatabase);
  const agentStore = createAgentService(paths, {
    stageRemoval: async (agentId, profile, options) => {
      const sessionIds = options.removeSessions ? await sessionMetadataStore.listIdsByAgent(agentId) : [];
      return durableDeletions.stage("agent", agentId, [
        join(paths.agentsDir, agentId),
        ...(options.removeWorkspace ? [profile.cwd] : []),
        ...(options.removeSessions ? [resolveAgentSessionDir(paths, agentId)] : []),
        ...sessionIds.map((sessionId) => join(paths.runDir, `${sessionId}.json`)),
      ]);
    },
    stageSessions: async (agentId) => {
      const source = resolveAgentSessionDir(paths, agentId);
      const staged = join(paths.trashDir, "sessions", `${Date.now()}-${agentId}-${randomUUID()}`);
      let moved = false;
      try {
        await access(source);
        await mkdir(dirname(staged), { recursive: true, mode: 0o700 });
        await rename(source, staged);
        moved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      return {
        async commit() {
          if (moved) await rm(staged, { recursive: true, force: true });
        },
        async rollback() {
          if (moved) await rename(staged, source);
        },
      };
    },
  }, createAgentRepository(applicationDatabase));
  const agentPrompts = new AgentPromptStore(paths.agentsDir);
  const embeddingConfigs = new EmbeddingConfigService(join(paths.appDir, "embedding.json"), {
    managedAvailable: deploymentCapabilities.managedEmbeddingAvailable,
  });
  const embeddingClient = new OpenAiEmbeddingClient(embeddingConfigs);
  const knowledgeBases = createKnowledgeBaseService({
    paths,
    store: createKnowledgeRepository(applicationDatabase),
    agentExists: async (agentId) => Boolean(await agentStore.get(agentId)),
    embeddingClient,
    isSemanticSearchEnabled: async () => (await embeddingConfigs.getPrivate())?.enabled ?? false,
    stageDeletion: (kind, entityId, targets) => durableDeletions.stage(kind, entityId, targets),
  });
  const workspaceFiles = createWorkspaceFileService(paths, agentStore);
  const workspaceFileManager = createWorkspaceFileManager(agentStore);
  const dataFiles = createDataFileService(paths, agentStore);
  const referenceResolver = createAgentReferenceResolver(async (agentId) => {
    const agent = await agentStore.get(agentId);
    if (!agent) {
      return { skills: [], knowledgeBases: [], workspaceEntries: [] };
    }
    const resources = await new ResourceService({ agentDir: paths.piDir, cwd: agent.profile.cwd }).catalog();
    const [knowledgeBasesForAgent, workspaceEntries] = await Promise.all([
      knowledgeBases.listBasesForAgent(agentId),
      workspaceFileManager.listReferences(agentId),
    ]);
    return {
      skills: resources.resources
        .filter((resource) => resource.type === "skill" && resource.enabled)
        .map((resource) => ({ name: resource.name })),
      knowledgeBases: knowledgeBasesForAgent.map((base) => ({ id: base.id, name: base.name })),
      workspaceEntries,
    };
  });
  const models = new ModelConfigService({
    modelsPath: resolve(paths.piDir, "models.json"),
    authPath: resolve(paths.piDir, "auth.json"),
  });
  const webResearchEgressProfiles = new EgressProfileRegistry(
    process.env.WEB_RESEARCH_EGRESS_PROFILES_PATH,
    process.env.WEB_RESEARCH_TRUSTED_FAKE_IP_CIDRS,
  );
  const managedSearchProviders = new ManagedSearchProviderRegistry(process.env.BUG_PAW_MANAGED_SEARCH_AVAILABLE === "true");
  const webResearchConfigPath = join(paths.appDir, "web-research.json");
  const webResearchAuthPath = join(paths.appDir, "web-research-auth.json");
  const webResearchConfigs = new WebResearchConfigService(webResearchConfigPath, webResearchEgressProfiles, managedSearchProviders);
  const webResearchCredentials = new CredentialService(webResearchAuthPath);
  const webResearchManagement = new WebResearchProviderManagementService({
    configs: webResearchConfigs,
    credentials: webResearchCredentials,
    configPath: webResearchConfigPath,
    authPath: webResearchAuthPath,
    transaction: new ConfigTransaction({ rootDir: paths.rootDir, transactionDir: paths.transactionDir }),
  });
  await webResearchConfigs.migrateLegacyConfig();
  const webResearch = createWebResearchService(
    webResearchConfigs,
    webResearchEgressProfiles,
    undefined,
    managedSearchProviders,
    webResearchCredentials,
  );
  const pdfClient = new SafeWebClient();
  const pdfEvidence = new PdfEvidenceService({
    readConfig: () => webResearchConfigs.read(),
    fetchPdf: async (url, config, signal) => pdfClient.fetchPdf(url, config, await webResearchEgressProfiles.require(config.webRead.egressProfileId), signal),
  });
  const browserConfigs = new BrowserConfigService(join(paths.appDir, "browser-automation.json"));
  const browserPreview = new BrowserPreviewService({
    internalOrigin: process.env.BUG_PAW_BROWSER_PREVIEW_ORIGIN ?? "http://bug-paw-web:7080",
  });
  const browserAudit = new BrowserAuditRepository(applicationDatabase);
  const browserRuns = new BrowserRunRegistry();
  let browserPool: BrowserResourcePool | undefined;
  let browserArtifacts: BrowserArtifactService | undefined;
  let browserAutomation: BrowserAutomationService | undefined;
  let browserWorker: BrowserWorkerClient | undefined;
  if (deploymentCapabilities.browserAutomationAvailable) {
    const tokenPath = process.env.BUG_PAW_BROWSER_TOKEN_FILE;
    const workerUrl = process.env.BUG_PAW_BROWSER_WORKER_URL;
    if (!tokenPath || !workerUrl) throw new Error("浏览器部署缺少内部通信配置");
    const secret = (await readFile(tokenPath, "utf8")).trim();
    if (!secret) throw new Error("浏览器内部通信密钥为空");
    browserWorker = new BrowserWorkerClient({ baseUrl: workerUrl, secret });
    const initialBrowserConfig = (await browserConfigs.read()).config;
    browserArtifacts = new BrowserArtifactService(initialBrowserConfig.artifacts);
    browserPool = new BrowserResourcePool(initialBrowserConfig.pool, {
      closeContext: (leaseId) => browserWorker!.closeContext(leaseId),
    });
    browserAutomation = new BrowserAutomationService({
      deploymentAvailable: true,
      readConfig: async () => (await browserConfigs.read()).config,
      runRegistry: browserRuns,
      pool: browserPool,
      worker: browserWorker,
      preview: browserPreview,
      artifacts: browserArtifacts,
      audit: browserAudit,
    });
  }
  const ttsConfigs = new TtsConfigService(join(paths.appDir, "tts.json"));
  const ttsSynthesis = new TtsSynthesisService(ttsConfigs);
  const whisper = new WhisperClient(process.env.BUG_PAW_WHISPER_URL ?? "http://bug-paw-whisper:7083");
  const aigcConnectionPath = join(paths.appDir, "aigc-connections.json");
  const aigcAuthPath = join(paths.appDir, "aigc-auth.json");
  const aigcConnections = new AigcConnectionService(aigcConnectionPath);
  const aigcCredentials = new CredentialService(aigcAuthPath);
  const aigcManagement = new AigcConnectionManagementService({
    connections: aigcConnections,
    credentials: aigcCredentials,
    configPath: aigcConnectionPath,
    authPath: aigcAuthPath,
    transaction: new ConfigTransaction({ rootDir: paths.rootDir, transactionDir: paths.transactionDir }),
  });
  const aigcWorkflows = new AigcWorkflowService(join(paths.appDir, "aigc-workflows", "definitions"), applicationDatabase);
  const aigcInterfaces = new AigcInterfaceService(join(paths.appDir, "aigc-interfaces.json"), (id) => aigcWorkflows.exists(id));
  const aigcAssets = new AigcAssetService(join(paths.appDir, "aigc-assets"));
  const aigcPublicFiles = new AigcPublicFileService(join(paths.appDir, "aigc-public-files"));
  const aigcPublicOrigin = resolveAigcPublicOrigin(process.env);
  const aigcSubmissionLocks = new KeyedMutex();
  const aigcAgentLimits = readAigcAgentLimits(process.env);
  const aigcComfyUiInputs = new AigcComfyUiInputService(aigcConnections, aigcCredentials);
  const aigcTasks = new AigcTaskService({
    repository: new AigcTaskRepository(join(paths.appDir, "aigc-tasks.json")),
    backgroundError: (error) => { backgroundErrors.record("REQUEST_FAILED"); app.log.error(error, "AIGC 队列执行或持久化失败"); },
    interfaces: aigcInterfaces,
    workflows: aigcWorkflows,
    connections: aigcConnections,
    credentials: aigcCredentials,
    assets: aigcAssets,
    publicFiles: aigcPublicFiles,
    adapters: {
      openai: new OpenAiAigcAdapter(),
      grok: new GrokAigcAdapter(),
      comfyui: new ComfyUiAigcAdapter(),
    },
  }, aigcAgentLimits);
  await aigcTasks.initialize();
  const aigcAgentService = new AigcAgentService({
    interfaces: aigcInterfaces, workflows: aigcWorkflows, connections: aigcConnections,
    tasks: aigcTasks, assets: aigcAssets, publicFiles: aigcPublicFiles, publicOrigin: aigcPublicOrigin,
    workspace: workspaceFileManager, files: workspaceFiles,
    allowedTools: async (agentId) => (await agentStore.get(agentId))?.profile.allowedTools ?? [],
  }, aigcAgentLimits, aigcSubmissionLocks);
  const aigcMcpService = new AigcMcpService({
    database: applicationDatabase, interfaces: aigcInterfaces, connections: aigcConnections,
    workflows: aigcWorkflows, tasks: aigcTasks, assets: aigcAssets,
    publicFiles: aigcPublicFiles, publicOrigin: aigcPublicOrigin,
  }, aigcSubmissionLocks, aigcAgentLimits);
  const aigcMediaProjects = new AigcMediaProjectService({
    filePath: join(paths.appDir, "aigc-media-editor.json"),
    outputRoot: join(paths.appDir, "aigc-media-renders"),
    tasks: aigcTasks,
    assets: aigcAssets,
    recordBackgroundError: (code, details) => backgroundErrors.record(code, details),
  });
  await recoverPendingProviderRenames(paths, models, agentStore);
  const credentials = new CredentialService(resolve(paths.piDir, "auth.json"));
  const providerModelDiscovery = createProviderModelDiscovery({ models, credentials });
  const createSharedModelRuntime = () => ModelRuntime.create({
    authPath: resolve(paths.piDir, "auth.json"),
    modelsPath: resolve(paths.piDir, "models.json"),
    allowModelNetwork: false,
  });
  let sharedModelRuntime = await createSharedModelRuntime();
  let scheduledTasks: ReturnType<typeof createScheduledTaskService> | undefined;
  let workflowTools: WorkflowToolService | undefined;
  const runtimeSupervisor = new RuntimeSupervisor({
      modelRuntime: sharedModelRuntime,
      resolveAgent: async (agentId) => {
        await agentStore.assertCanCreateSession(agentId);
        return { cwd: await agentStore.resolveWorkspace(agentId) };
      },
      createRuntime: async ({ agentId, cwd, modelRuntime }) => {
        if (options.runtimeFactory) {
          return options.runtimeFactory(paths);
        }
        const profile = await agentStore.get(agentId);
        if (!profile) {
          throw new Error("Agent 不存在");
        }
        const webResearchConfig = (await webResearchConfigs.read()).config;
        const retrievalCapabilities = resolveEffectiveRetrievalCapabilities({
          allowedTools: profile.profile.allowedTools,
          webResearchEnabled: webResearchConfig.enabled,
        });
        const browserConfig = (await browserConfigs.read()).config;
        const browserCapabilities = resolveBrowserCapabilities({
          allowedTools: profile.profile.allowedTools,
          enabled: browserConfig.enabled,
          deploymentAvailable: deploymentCapabilities.browserAutomationAvailable,
        });
        return createSdkPiRuntimeGateway({
          agentId,
          cwd,
          agentDir: paths.piDir,
          modelRuntime,
          defaultModel: profile.profile.defaultModel,
          defaultThinkingLevel: profile.profile.defaultThinkingLevel,
          titleGeneration: profile.profile.titleGeneration,
          allowedTools: profile.profile.allowedTools,
          retrievalCapabilities,
          customTools: [
            ...(retrievalCapabilities.knowledgeSearch ? [createKnowledgeSearchTool(agentId, knowledgeBases)] : []),
            ...(retrievalCapabilities.knowledgeRead ? [createKnowledgeReadTool(agentId, knowledgeBases)] : []),
            ...(profile.profile.allowedTools.includes("knowledge_manage")
              ? [createKnowledgeManageTool(agentId, knowledgeBases, workspaceFileManager)]
              : []),
          ],
          createRuntimeTools: ({ sessionText }) => createSessionTextTools(sessionText),
          createSessionTools: ({ searchRunState, sessionId, branchAnchorId }) => [
            ...(scheduledTasks && profile.profile.allowedTools.includes("scheduled_tasks")
              ? [createScheduledTasksTool({ agentId, sessionId }, scheduledTasks)] : []),
            ...(workflowTools ? createWorkflowTools({ agentId, sessionId }, workflowTools).filter(tool => profile.profile.allowedTools.includes(tool.name)) : []),
            ...createAigcAgentTools({ agentId, sessionId }, aigcAgentService)
              .filter((tool) => profile.profile.allowedTools.includes(tool.name)),
            ...(profile.profile.allowedTools.includes("ask_user")
              ? [createAskUserTool({ agentId, sessionId, branchAnchorId, repository: sessionQuestions })]
              : []),
            ...(retrievalCapabilities.webRead ? [createWebReadTool(webResearch, searchRunState.evidence)] : []),
            ...(retrievalCapabilities.pdfRead ? [createPdfReadTool(pdfEvidence, searchRunState.evidence)] : []),
            ...(retrievalCapabilities.webResearch ? [createWebResearchTool(webResearch, searchRunState)] : []),
            ...(retrievalCapabilities.webSearch
              ? [createWebSearchTool({ search: (input) => webResearch.search(input, searchRunState) })]
              : []),
            ...(browserAutomation
              ? createBrowserTools({ sessionId }, browserAutomation).filter((tool) => browserCapabilities.toolNames.includes(tool.name as never))
              : []),
          ],
          appendSystemPrompt: [
            ...(browserCapabilities.toolNames.length > 0 ? [AgentSystemPromptConfiguration.browserAutomationPolicy] : []),
            ...(profile.profile.allowedTools.some((name) => name.startsWith("aigc_")) ? [AgentSystemPromptConfiguration.aigcPolicy] : []),
          ],
          resolveAgentPromptContext: () => agentPrompts.readContext(agentId),
          sessionDir: resolveAgentSessionDir(paths, agentId),
          checkpointStore: createRunCheckpointStore(paths.runDir),
          sessionMetadataStore,
          questionState: questionStateFor(agentId),
          onToolCallCircuitBreak: (event) => {
            app.log.error(event, event.action === "terminated"
              ? "模型重复生成无效工具参数，Run 已终止"
              : "模型生成无效工具参数，断路器正在计数");
          },
          stageSessionDeletion: (sessionId, sessionFile) => durableDeletions.stage("session", sessionId, [
            sessionFile,
            join(paths.runDir, `${sessionId}.json`),
          ]),
          onBackgroundError: (error) => {
            backgroundErrors.record(error.code, error.sessionId ? { sessionId: error.sessionId } : undefined);
            app.log.error(error, "Runtime 后台任务失败");
          },
          onSessionTitleGenerated: (event) => {
            app.log.info(event, "自动会话标题任务完成");
          },
          onRunStarted: ({ runId, sessionId }) => {
            browserRuns.begin({ agentId, sessionId, runId, cwd });
          },
          onRunFinished: async ({ runId, sessionId, status }) => {
            try {
              await browserAutomation?.finishRun(runId, status === "completed" ? "run_completed" : status === "aborted" ? "run_aborted" : "run_error");
              browserPreview.revokeRun(runId);
              browserRuns.end(sessionId, runId);
            } catch {
              browserRuns.end(sessionId, runId);
              throw new Error("浏览器 Run 清理失败");
            }
          },
        });
      },
    });
  const runtimeCoordinator: RuntimeCoordinator = createRuntimeCoordinator({
      modelRuntime: sharedModelRuntime,
      runtimeSupervisor,
      recreateModelRuntime: createSharedModelRuntime,
      onModelRuntimeReplaced: (modelRuntime) => { sharedModelRuntime = modelRuntime; },
    });
  const sessionBulk = createSessionBulkService({
    repository: sessionBulkRepository,
    acquireRuntime: async (agentId) => {
      const lease = await runtimeSupervisor.acquire(agentId);
      return { runtime: lease.runtime, release: lease.release };
    },
    onCleanupError: (error) => {
      backgroundErrors.record("SESSION_DELETE_CLEANUP_FAILED", { sessionId: error.sessionId });
      app.log.error(error, "Session 暂存文件清理失败");
    },
  });
  const providerRenameService = new ProviderRenameService({
    paths,
    models,
    agents: agentStore,
    beginRuntimeMaintenance: () => runtimeSupervisor.beginMaintenance(),
    refreshModels: () => runtimeCoordinator.refreshModels(),
  });
  scheduledTasks = createScheduledTaskService({
    store: scheduledTaskStore,
    acquireRuntime: async (agentId) => {
      const lease = await runtimeSupervisor.acquire(agentId);
      return { runtime: lease.runtime, release: lease.release };
    },
    assignSession: (sessionId, agentId) => sessionMetadataStore.assignAgent(sessionId, agentId),
    archiveSession: (sessionId) => sessionMetadataStore.archive(sessionId),
    sessionIsPersisted: (agentId, sessionId) => hasPersistedSessionFile(paths, agentId, sessionId),
    assertSessionRunnable: (agentId, sessionId) => questionService.assertAutomationCanStart(agentId, sessionId),
    onBackgroundError: (error) => {
      backgroundErrors.record(error.code, { taskId: error.taskId });
      app.log.error(error, "定时任务后台执行失败");
    },
  });
  const chatService = new ChatApplicationService({
    runtimeSupervisor,
    sessionAgent: (sessionId) => resolveSessionAgentId(sessionId, sessionMetadataStore),
    workspaceFiles,
    referenceResolver,
    questions: questionService,
  });
  const workflowFiles = new WorkflowFiles(join(paths.appDir, "workflows", "assets"), workspaceFileManager, workspaceFiles);
  const workflowExecutor = new WorkflowNodeExecutor({
    modelRuntime: () => sharedModelRuntime, agents: agentStore, runtimes: runtimeSupervisor, files: workflowFiles,
    interfaces: aigcInterfaces, aigcWorkflows, aigcTasks, aigcAssets, publicFiles: aigcPublicFiles, publicOrigin: aigcPublicOrigin,
    assignSession: (sessionId, agentId) => sessionMetadataStore.assignAgent(sessionId, agentId),
    sessionAgent: (sessionId) => resolveSessionAgentId(sessionId, sessionMetadataStore),
    assertSessionRunnable: (agentId, sessionId) => questionService.assertAutomationCanStart(agentId, sessionId),
  });
  const workflows = new WorkflowService(new WorkflowRepository(join(paths.appDir, "workflows"), applicationDatabase), workflowExecutor, error => {
    backgroundErrors.record("REQUEST_FAILED");
    app.log.error(error, "工作流持久化或后台执行失败");
  }, (definition, inputs) => workflowFiles.checkReferences(definition, inputs));
  await workflows.initialize();
  workflowTools = new WorkflowToolService(workflows, workflowFiles, async agentId => (await agentStore.get(agentId))?.profile.allowedTools ?? []);
  await agentStore.removeToolPermissions(RETIRED_AGENT_TOOL_NAMES);
  await agentStore.ensureSystemToolPermissions(STARTUP_ENFORCED_SYSTEM_TOOL_NAMES);
  if (scheduledTasks) await ensureScheduledTaskSkill(paths.piDir);
  await ensureSkillCreatorGlobalSkill(paths.piDir);
  const deepResearchSkill = await ensureDeepResearchGlobalSkill(paths.piDir);
  if (deepResearchSkill.status !== "current") {
    app.log.info(deepResearchSkill, "通用深度研究 Skill 初始化完成");
  }
  const legacySkillCleanup = await cleanupBundledRetrievalSkills(paths.piDir);
  for (const result of legacySkillCleanup) {
    if (result.status !== "absent") app.log.info(result, "检索内置 Skill 清理完成");
  }
  await scheduledTasks?.start();
  const composerCatalog = new ComposerCatalogService({
    agents: agentStore,
    agentDir: paths.piDir,
    knowledgeBases,
    workspaceFiles: workspaceFileManager,
    listCommandsForAgent: async (agentId) => {
      const lease = await runtimeSupervisor.acquire(agentId);
      try {
        return await lease.runtime.listCommands();
      } finally {
        lease.release();
      }
    },
  });

  app.get("/healthz", async () => ({ status: "ok" }));
  registerStatusRoutes(app, { paths, authService });
  registerSetupRoutes(app, {
    paths,
    identityRepository: identities,
    onInitialized: async () => {
      try {
        await runtimeCoordinator.refreshModels();
      } catch (error) {
        backgroundErrors.record("RUNTIME_INITIALIZATION_REFRESH_FAILED");
        app.log.error(error, "首启后刷新 Runtime 失败");
      }
    },
  });
  registerAuthRoutes(app, { authService, paths });
  registerModelRoutes(app, {
    authService,
    listModels: () => runtimeCoordinator.listModels(),
  });
  registerSessionRoutes(app, {
    authService,
    runtimeSupervisor,
    sessionMetadata: sessionMetadataStore,
    scheduledTasks,
    sessionBulk,
    assertCanCreateSession: (agentId) => agentStore.assertCanCreateSession(agentId),
  });
  registerScheduledTaskRoutes(app, { authService, service: scheduledTasks });
  registerChatRoutes(app, { authService, runtimeSupervisor, sessionMetadata: sessionMetadataStore, workspaceFiles, referenceResolver, chatService });
  registerAttachmentRoutes(app, {
    authService,
    files: workspaceFiles,
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
  });
  registerDataFileRoutes(app, { authService, files: dataFiles });
  registerKnowledgeBaseRoutes(app, { authService, service: knowledgeBases });
  registerWorkspaceFileRoutes(app, {
    authService,
    manager: workspaceFileManager,
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
  });
  registerComposerCatalogRoutes(app, { authService, catalog: composerCatalog });
  registerAgentRoutes(app, {
    authService,
    store: agentStore,
    prompts: agentPrompts,
    removeAgent: (agentId) => runtimeCoordinator.removeAgent(agentId),
    finalizeAgentRemoval: (agentId) => runtimeCoordinator.finalizeAgentRemoval(agentId),
    restoreAgent: (agentId) => runtimeCoordinator.restoreAgent(agentId),
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
    runModelMutation: (operation) => modelMutations.run("models-and-agent-defaults", operation),
    beginAgentRemoval: (agentId) => agentLifecycle.beginRemoval(agentId),
    countSessions: async (agentId) => (await sessionMetadataStore.listIdsByAgent(agentId)).length,
    resolveAvailableModel: async (provider, modelId) => {
      // 以当前 revisioned models.json 做提交时完整性校验，不能依赖可能尚未手动刷新的 Runtime 缓存。
      const document = await models.read();
      const providers = document.value.providers;
      const providerNode = providers && typeof providers === "object" && !Array.isArray(providers)
        ? (providers as Record<string, unknown>)[provider]
        : undefined;
      const modelNodes = providerNode && typeof providerNode === "object" && !Array.isArray(providerNode)
        ? (providerNode as Record<string, unknown>).models
        : undefined;
      const model = Array.isArray(modelNodes)
        ? modelNodes.find((candidate) => candidate && typeof candidate === "object" && (candidate as Record<string, unknown>).id === modelId) as Record<string, unknown> | undefined
        : undefined;
      return model ? {
        reasoning: model.reasoning === true,
        ...(model.thinkingLevelMap && typeof model.thinkingLevelMap === "object" ? { thinkingLevelMap: model.thinkingLevelMap as Partial<Record<NonNullable<AgentProfile["defaultThinkingLevel"]>, string | null>> } : {}),
      } : undefined;
    },
  });
  registerProviderRoutes(app, {
    authService,
    models,
    credentials,
    agents: agentStore,
    renameService: providerRenameService,
    testModels: (providerId, request) => runtimeCoordinator.testModels(providerId, request),
    discoverModels: (providerId) => providerModelDiscovery.discover(providerId),
    runModelMutation: (operation) => modelMutations.run("models-and-agent-defaults", operation),
  });
  registerConfigurationRoutes(app, {
    authService,
    paths,
    overviewReaders: {
      agents: async () => ({ summary: `${(await agentStore.list()).length} 个已配置 Agent` }),
      providers: async () => {
        const providers = Object.keys((await models.read()).value.providers ?? {});
        const configured = (await credentials.list()).filter((item) => providers.includes(item.providerId) && item.configured).length;
        return { summary: `${providers.length} 个 Provider · ${configured} 个已配置凭证`, needsConfiguration: providers.length === 0 };
      },
      "pi-settings": async () => {
        const value = await createVersionedJsonStore<Record<string, unknown>>(join(paths.piDir, "settings.json")).read();
        return { summary: value.exists ? "已保存全局设置；Agent 可独立覆盖" : "未声明全局设置，沿用核心默认值" };
      },
      resources: async () => {
        const value = (await createVersionedJsonStore<Record<string, unknown>>(join(paths.piDir, "settings.json")).read()).value;
        return { summary: `${Array.isArray(value?.packages) ? value.packages.length : 0} 个全局配置包来源 · 不代表已加载` };
      },
      "web-research": async () => { const { config } = await webResearchConfigs.read(); return { summary: `已保存：${config.enabled ? "启用" : "关闭"} · ${config.searchProviders.length} 个搜索渠道` }; },
      "browser-automation": async () => { const { config } = await browserConfigs.read(); return { summary: `${deploymentCapabilities.browserAutomationAvailable ? "部署包含组件" : "未部署组件"} · 已保存：${config.enabled ? "启用" : "停用"}` }; },
      "aigc-channels": async () => ({ summary: `${(await aigcConnections.list()).channels.length} 个已配置渠道 · 不代表测试通过` }),
      tts: async () => ({ summary: `${(await ttsConfigs.list()).profiles.length} 个已配置语音方案` }),
      "knowledge-retrieval": async () => { const { config } = await embeddingConfigs.read(); return { summary: config ? `${config.isManaged ? "内置服务" : "外部兼容服务"} · 已保存：${config.enabled ? "启用" : "关闭"}` : "尚未配置服务", needsConfiguration: !config }; },
    },
    agents: agentStore,
    historyRepository: createConfigurationHistoryRepository(applicationDatabase),
    backgroundErrors: () => backgroundErrors.summary(),
    operationalStatus: () => ({
      database: {
        quickCheck: applicationDatabase.readOne<{ quick_check: string }>("PRAGMA quick_check")?.quick_check ?? "unknown",
        journalMode: applicationDatabase.readOne<{ journal_mode: string }>("PRAGMA journal_mode")?.journal_mode ?? "unknown",
      },
      runtime: {
        activeLeases: runtimeSupervisor.activeLeaseCount,
        trackedAgents: runtimeSupervisor.trackedAgentCount,
      },
      limits: {
        runtimeSessionsPerAgent: SYSTEM_LIMITS.runtimeSessionsPerAgent,
        sseQueueEntries: SYSTEM_LIMITS.sseQueueEntries,
        sseQueueBytes: SYSTEM_LIMITS.sseQueueBytes,
        workspaceEntries: SYSTEM_LIMITS.workspaceEntries,
        resourceTasks: SYSTEM_LIMITS.resourceTasks,
      },
    }),
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
    refreshAgent: (agentId) => runtimeCoordinator.refreshAgent(agentId),
    runModelMutation: (operation) => modelMutations.run("models-and-agent-defaults", operation),
    refreshRuntime: () => runtimeCoordinator.refreshRuntime(),
  });
  registerWebResearchRoutes(app, {
    authService,
    configs: webResearchConfigs,
    credentials: webResearchCredentials,
    management: webResearchManagement,
    managedProviders: managedSearchProviders,
    service: webResearch,
    egressProfiles: webResearchEgressProfiles,
    refreshRuntime: () => runtimeCoordinator.refreshRuntime(),
  });
  registerTtsRoutes(app, {
    authService,
    configs: ttsConfigs,
    synthesize: ttsSynthesis,
    isProfileInUse: async (profileId) => (await agentStore.list()).some((agent) => agent.profile.ttsProfileId === profileId),
    getAgentTtsProfile: async (agentId) => {
      const profile = (await agentStore.get(agentId))?.profile;
      return profile?.ttsProfileId ? {
        profileId: profile.ttsProfileId,
        voice: profile.ttsVoice,
        customParameters: profile.ttsCustomParameters,
      } : undefined;
    },
  });
  registerSpeechRoutes(app, { authService, whisper });
  registerKnowledgeRetrievalRoutes(app, {
    authService,
    configs: embeddingConfigs,
    rebuildAll: () => knowledgeBases.rebuildSemanticIndex(),
  });
  registerAigcChannelRoutes(app, {
    authService,
    management: aigcManagement,
    validation: new AigcConnectionValidation(),
    credentials: aigcCredentials,
    isChannelInUse: (channelId) => aigcInterfaces.isChannelInUse(channelId),
  });
  registerAigcRoutes(app, {
    authService,
    workflows: aigcWorkflows,
    interfaces: aigcInterfaces,
    tasks: aigcTasks,
    assets: aigcAssets,
    publicFiles: aigcPublicFiles,
    comfyuiInputs: aigcComfyUiInputs,
    mediaProjects: aigcMediaProjects,
  });
  registerAigcMcpRoutes(app, { authService, service: aigcMcpService });
  registerWorkflowRoutes(app, { authService, service: workflows, executor: workflowExecutor, files: workflowFiles });
  registerBrowserPreviewRoutes(app, browserPreview);
  registerBrowserAutomationRoutes(app, {
    authService,
    configs: browserConfigs,
    deploymentAvailable: deploymentCapabilities.browserAutomationAvailable,
    status: async () => {
      const pool = browserPool?.status() ?? { activeContexts: 0, queuedRequests: 0 };
      if (!browserWorker) return { workerAvailable: false, chromiumReady: false, ...pool };
      try {
        await browserWorker.health();
        return { workerAvailable: true, chromiumReady: true, ...pool };
      } catch (error) {
        return { workerAvailable: false, chromiumReady: false, ...pool, lastFailureAt: new Date().toISOString(), lastFailureCode: "BROWSER_WORKER_UNAVAILABLE", lastFailureMessage: `Browser Worker 健康检查：${toSafePublicMessage(error, "捕获到非 Error 异常")}` };
      }
    },
    test: async () => {
      try {
        await browserWorker?.health();
        return { ok: Boolean(browserWorker), message: browserWorker ? "浏览器组件可用" : "当前部署未包含浏览器执行组件" };
      } catch (error) { return { ok: false, message: `Browser Worker 组件测试：${toSafePublicMessage(error, "捕获到非 Error 异常")}` }; }
    },
    audit: browserAudit,
    onConfigUpdated: async (previous, current) => {
      if (browserPool) {
        await browserPool.reconfigure(current.pool);
        browserArtifacts?.reconfigure(current.artifacts);
        if (previous.enabled && !current.enabled) await browserPool.disable();
      }
      await runtimeCoordinator.refreshRuntime();
    },
  });
  const resourceTasks = new ResourceTaskManager();
  registerResourceRoutes(app, {
    authService,
    paths,
    agents: agentStore,
    tasks: resourceTasks,
    runAgentMutation: (agentId, operation) => agentLifecycle.runMutation(agentId, operation),
  });

  await app.register(fastifyStatic, {
    root: staticRoot,
    wildcard: false,
    maxAge: "1h",
    setHeaders: (reply, filePath) => {
      // Service Worker 本身必须每次校验，避免已安装 PWA 因静态长缓存继续运行旧入口。
      if (filePath === join(staticRoot, "sw.js")) reply.header("Cache-Control", "no-cache");
    },
  });

  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/")) {
      exposeRequestId(request, reply);
      return sendApiError(reply, 404, "NOT_FOUND", "接口不存在");
    }
    reply.header("Cache-Control", "no-cache");
    return reply.sendFile("index.html", { cacheControl: false });
  });

  app.addHook("onClose", async () => {
    await workflows.close();
    await aigcTasks.close();
    await browserPool?.close();
    const schedulerDrained = await scheduledTasks.stopAndDrain(5_000);
    const resourcesDrained = await resourceTasks.stopAndDrain(5_000);
    await runtimeCoordinator.dispose();
    if (!schedulerDrained && !await scheduledTasks.stopAndDrain(5_000)) {
      throw new Error("定时任务未能在关闭预算内排空，拒绝关闭数据库");
    }
    if (!resourcesDrained && !await resourceTasks.stopAndDrain(5_000)) {
      throw new Error("资源任务未能在关闭预算内排空，拒绝释放实例锁");
    }
    applicationDatabase.close();
    await instanceLock.release();
  });
    return app;
  } catch (error) {
    // 启动装配可能在 onClose 钩子注册前失败，此处必须显式归还全部进程级资源。
    database?.close();
    await instanceLock.release();
    throw error;
  }
}

/** 解析 Agent 发布 Grok 媒体时使用的无认证公开 Origin。 */
function resolveAigcPublicOrigin(env: NodeJS.ProcessEnv): string | undefined {
  if (env.BUG_PAW_PUBLIC_ORIGIN?.trim()) return env.BUG_PAW_PUBLIC_ORIGIN.trim();
  const address = env.BUG_PAW_BIND_ADDRESS?.trim();
  if (!address || ["0.0.0.0", "::", "[::]"].includes(address)) return undefined;
  const host = address.includes(":") && !address.startsWith("[") ? `[${address}]` : address;
  return `http://${host}:${env.BUG_PAW_PORT?.trim() || "7080"}`;
}

interface GracefulShutdownOptions {
  close(): Promise<void>;
  logError(error: unknown, message: string): void;
  exit(code: number): void;
}

/**
 * 创建幂等的进程关闭入口，避免多个终止信号重复释放同一组资源。
 */
export function createGracefulShutdown(options: GracefulShutdownOptions): () => Promise<void> {
  let closing: Promise<void> | undefined;
  return () => {
    closing ??= options.close().then(
      () => options.exit(0),
      (error: unknown) => {
        options.logError(error, "服务关闭失败");
        options.exit(1);
      },
    );
    return closing;
  };
}

/**
 * 启动容器内服务并处理优雅退出。
 */
export async function startServer(): Promise<void> {
  const app = await buildServer({ logger: true });
  const close = createGracefulShutdown({
    close: () => app.close(),
    logError: (error, message) => app.log.error(error, message),
    exit: (code) => process.exit(code),
  });
  process.once("SIGINT", () => { void close(); });
  process.once("SIGTERM", () => { void close(); });
  await app.listen({ host: "0.0.0.0", port: Number(process.env.PORT ?? 7080) });
}

const entryFile = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : undefined;
if (entryFile === import.meta.url) {
  startServer().catch((error: unknown) => {
    console.error(error);
    process.exit(1);
  });
}
