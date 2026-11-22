import type { FastifyInstance, FastifyRequest } from "fastify";
import type { RunTemplateDomain, RunTemplateDraft } from "../../shared/run-template-contracts";
import { DomainError } from "../core/errors";
import type { RunTemplateRepository, TemplateSnapshot } from "../run-templates/run-template-repository";
import { checkTemplateValues } from "../run-templates/template-values";
import { invalid, record } from "../workflows/workflow-validation";
import type { AuthService } from "./auth";
import { requireAuthentication } from "./protected";

interface Projection {
  targetName: string;
  snapshot: TemplateSnapshot;
  issues: RunTemplateDraft["issues"];
}

interface TemplateTargets {
  list(): Promise<{id: string; name: string}[]>;
  project(targetId: string, inputs: Record<string, unknown>, previous: TemplateSnapshot | undefined, request: FastifyRequest): Promise<Projection>;
}

/** 两个固定路由各自绑定业务域，不能由请求正文切换工作台或覆盖对象。 */
export function registerRunTemplateRoutes(app: FastifyInstance, auth: AuthService, repo: RunTemplateRepository,
  domain: RunTemplateDomain, targets: TemplateTargets) {
  const base = domain === "aigc" ? "/api/aigc/run-templates" : "/api/workflows/run-templates";
  type ById = { Params: { id: string } };
  async function save(request: FastifyRequest, id?: string) {
    const body = request.body;
    if (!record(body) || typeof body.targetId !== "string" || !body.targetId || !record(body.inputs))
      invalid("保存模板需要运行对象标识和参数对象");
    const { targetId, inputs } = body;
    if (id && repo.get(domain, id).targetId !== targetId)
      throw new DomainError("RUN_TEMPLATE_CONFLICT", "只能覆盖当前运行对象的模板");
    checkTemplateValues(inputs);
    const { targetName, snapshot, issues } = await targets.project(targetId, inputs, undefined, request);
    if (issues.length) {
      const issue = issues[0];
      throw new DomainError("VALIDATION_FAILED", issue.field + "：" + issue.message, { field: issue.field, issues });
    }
    return id ? repo.overwrite(domain, id, targetId, targetName, snapshot)
      : repo.create(domain, targetId, targetName, body.name, snapshot);
  }
  app.register(async router => {
    router.addHook("preHandler", async (request, reply) => {
      reply.header("Cache-Control", "no-store");
      if (!await requireAuthentication(request, reply, auth)) return reply;
    });
    router.get(base, async () => {
      const names = new Map((await targets.list()).map(item => [item.id, item.name]));
      return { templates: repo.list(domain).map(row => ({ ...row, targetName: names.get(row.targetId) ?? row.targetName })) };
    });
    router.post(base, async (request, reply) => reply.code(201).send(await save(request)));
    router.put<ById>(base + "/:id", async request => save(request, request.params.id));
    router.patch<ById>(base + "/:id", async request => repo.rename(domain, request.params.id,
      record(request.body) ? request.body.name : undefined));
    router.delete<ById>(base + "/:id", async (request, reply) => {
      repo.remove(domain, request.params.id);
      return reply.code(204).send();
    });
    router.get<ById>(base + "/:id/draft", async request => {
      const { targetId, snapshot } = repo.get(domain, request.params.id);
      const projection = await targets.project(targetId, snapshot.inputs, snapshot, request);
      const clearedFields = Object.keys(snapshot.types).filter(name =>
        Object.hasOwn(projection.snapshot.types, name) && !Object.hasOwn(snapshot.inputs, name));
      return { targetId, inputs: projection.snapshot.inputs, issues: projection.issues, count: 1,
        ...(clearedFields.length ? { clearedFields } : {}) } satisfies RunTemplateDraft;
    });
  });
}
