// @vitest-environment node
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { emptyWorkflow, newWorkflowNode, workflowLoopOutputs } from "../../shared/workflow-contracts";
import { createTestDatabase } from "../database/test-database";
import { WorkflowRepository } from "./workflow-repository";
import { WorkflowService } from "./workflow-service";
import { WorkflowFiles } from "./workflow-files";
import { WorkflowFileManager } from "./workflow-file-manager";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
/** 使用真实资产目录、定义存储和执行器边界验证引用保护。 */
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "workflow-file-manager-"));
  const files = new WorkflowFiles(join(directory,"assets"), {} as never, {} as never);
  const repository = new WorkflowRepository(directory, createTestDatabase());
  const execute = vi.fn(async () => ({}));
  const service = new WorkflowService(repository, {execute}, undefined, (definition,inputs) => files.checkReferences(definition,inputs));
  await service.initialize();
  cleanup.push(async () => {await service.close();await rm(directory,{recursive:true,force:true});});
  const upload = (name = "file.txt", constant = false, runId?: string) => files.upload(Readable.from("测试文件内容"),name,"text/plain",undefined,constant ? "constants" : "runtime",runId);
  return {directory, files, service, repository, execute, manager:new WorkflowFileManager(files,service), upload};
}
it("文件常量物理隔离，未引用常量可删除，已保存默认值和循环固定值受到保护", async () => {
  const f = await fixture(), constant = await f.upload("constant.txt",true), unused = await f.upload("unused.txt",true), runtime = await f.upload();
  expect((await f.files.resolve(constant)).path).toContain("/assets/constants/inputs/");
  expect((await f.files.resolve(runtime)).path).toContain("/assets/inputs/");
  const draft = emptyWorkflow();
  draft.nodes[0].outputs.push({name:"file",type:"file",defaultValue:constant});
  const saved = await f.service.save(draft);
  const page = await f.manager.list({directory:"constants"});
  expect(page.files.find((item) => item.assetId === constant.assetId)?.blockedReason).toContain("引用");
  await expect(f.manager.remove([unused.assetId,constant.assetId])).rejects.toMatchObject({code:"CONFLICT"});
  await expect(f.files.resolve(unused)).resolves.toBeDefined();
  await f.manager.remove([unused.assetId]);
  await expect(f.files.resolve(unused)).rejects.toThrow("工作流文件不存在");
  const loop = newWorkflowNode("loop","loop");
  loop.config.loop!.body.nodes[0].outputs.push({name:"file",type:"file"});
  loop.inputs.file = {kind:"literal",value:constant};
  const next = emptyWorkflow();next.nodes.splice(1,0,loop);next.nodes[2].outputs = workflowLoopOutputs(loop.config.loop!);next.nodes[2].inputs.result = {kind:"reference",nodeId:"loop",field:"result"};
  next.edges = [{id:"a",source:"input",target:"loop"},{id:"b",source:"loop",target:"output"}];
  await f.service.remove(saved.id,saved.revision);
  const nested = await f.service.save(next);
  await expect(f.manager.remove([constant.assetId])).rejects.toMatchObject({code:"CONFLICT"});
  await f.service.remove(nested.id,nested.revision);
  await f.manager.remove([constant.assetId]);
  expect((await f.manager.list({directory:"constants"})).total).toBe(0);
});
it("运行文件按资产去重并保留输入输出关联，删除后历史保留且启动拒绝已删除输入", async () => {
  const f = await fixture(), input = await f.upload(), output = await f.upload("output.txt");
  const draft = emptyWorkflow();draft.nodes[0].outputs = [{name:"file",type:"file",required:true}];draft.nodes[1].outputs = [{name:"result",type:"file"}];draft.nodes[1].inputs.result = {kind:"reference",nodeId:"input",field:"file"};
  const definition = await f.service.save(draft), run = await f.service.start(definition.id,{file:input},"files");
  await f.service.wait(run.id);
  const history = f.service.getRun(run.id);history.nodes[1].outputs!.extra = output;
  await f.repository.saveRun(history);
  const other = structuredClone(history);other.id = "00000000-0000-4000-8000-000000000001";other.workflowId = "other-workflow";other.definition.id = other.workflowId;other.definition.name = "其他工作流";other.inputs = {};other.outputs = {file: input};other.nodes = [];
  await f.repository.saveRun(other);
  const restarted = new WorkflowService(f.repository,{execute:async()=>({})});await restarted.initialize();
  const manager = new WorkflowFileManager(f.files,restarted);
  expect((await manager.list({workflowId: definition.id, runId: other.id})).total).toBe(0);
  expect((await manager.list({workflowId: other.workflowId, role: "input"})).total).toBe(0);
  expect((await manager.list({workflowId: other.workflowId, role: "output"})).total).toBe(1);
  const list = await new WorkflowFileManager(f.files,restarted).list({directory:"runtime",workflowId:definition.id});
  expect(list.total).toBe(2);expect(list.files.find(item => item.assetId === output.assetId)?.usages).toEqual(expect.arrayContaining([expect.objectContaining({role:"output"})]));
  expect(list.files.find(item => item.assetId === input.assetId)!.usages.map((usage) => usage.role)).toEqual(expect.arrayContaining(["input","output"]));
  await f.manager.remove([input.assetId]);
  const annotated = await f.files.annotateDeleted(f.service.getRun(run.id));
  expect((annotated.inputs.file as {deleted:boolean}).deleted).toBe(true);
  expect(annotated.status).toBe("succeeded");await restarted.close();
  await expect(f.service.start(definition.id,{file:input},"deleted")).rejects.toThrow("不存在");
});
it("执行中和运行快照的文件常量均不可删除，重启后保护仍存在", async () => {
  const f = await fixture(), constant = await f.upload("constant.txt",true);
  const draft = emptyWorkflow();draft.nodes[0].outputs.push({name:"file",type:"file",defaultValue:constant});
  const definition = await f.service.save(draft), run = await f.service.start(definition.id,{prompt:"test"},"snapshot");await f.service.wait(run.id);
  const next = structuredClone(definition);next.nodes[0].outputs.pop();await f.service.save(next,next.id,next.revision);
  await expect(f.manager.remove([constant.assetId])).rejects.toMatchObject({code:"CONFLICT"});
  const active = f.service.getRun(run.id);active.id = "active-run";active.status = "running";active.nodes = [];
  const runtime = await f.upload("pending-output.txt",false,active.id);
  await f.repository.saveRun(active);
  // 模拟生成文件尚未进入节点结果，但运行 ID 已登记的窗口。
  const snapshot = vi.spyOn(f.service,"fileUsageSnapshot").mockReturnValue({definitions:[],runs:[active]});
  await expect(f.manager.remove([runtime.assetId])).rejects.toThrow("运行中");snapshot.mockRestore();
  const restarted = new WorkflowService(f.repository,{execute:async()=>({})});await restarted.initialize();
  await expect(new WorkflowFileManager(f.files,restarted).remove([constant.assetId])).rejects.toMatchObject({code:"CONFLICT"});await restarted.close();
});
it("保存和删除共用临界区，先发起的删除完成后保存不能写入悬空引用", async () => {
  const f = await fixture(), constant = await f.upload("race.txt",true);
  const draft = emptyWorkflow();draft.nodes[0].outputs.push({name:"file",type:"file",defaultValue:constant});
  const deletion = f.manager.remove([constant.assetId]), saving = f.service.save(draft);
  await deletion;await expect(saving).rejects.toThrow("不存在");expect(await f.service.list()).toEqual([]);
});
it("拒绝运行文件写入常量定义，目录和分页查询有界，文本预览保留内容", async () => {
  const f = await fixture(), file = await f.upload("readme.txt");
  const draft = emptyWorkflow();draft.nodes[0].outputs.push({name:"file",type:"file",defaultValue:file});
  await expect(f.service.save(draft)).rejects.toThrow("文件常量目录");
  expect(await f.files.text(file.assetId)).toMatchObject({content:"测试文件内容",truncated:false});
  const image = await f.files.upload(Readable.from("fake"),"image.png","image/png");
  await expect(f.files.text(image.assetId)).rejects.toMatchObject({code:"TEXT_PREVIEW_UNAVAILABLE"});
  expect((await f.manager.list({directory:"runtime",q:"readme",pageSize:"1"})).total).toBe(1);
  await expect(f.manager.list({directory:"../"})).rejects.toMatchObject({code:"VALIDATION_FAILED"});
  await expect(f.manager.list({pageSize:"101"})).rejects.toMatchObject({code:"VALIDATION_FAILED"});
  await expect(f.manager.remove(["../../outside"])).rejects.toMatchObject({code:"VALIDATION_FAILED"});
});

it("目录清理跨越批量上限，隔离目录并保留引用文件与运行中新产物", async () => {
  const f = await fixture();
  for (let i = 0; i < 105; i++) await f.upload(`file-${i}.txt`);
  const constant = await f.upload("constant.txt", true), unused = await f.upload("unused.txt", true);
  const draft = emptyWorkflow();draft.nodes[0].outputs.push({name:"file",type:"file",defaultValue:constant});
  const saved = await f.service.save(draft);
  const run = await f.service.start(saved.id, {prompt:"test"}, "cleanup");await f.service.wait(run.id);
  const active = f.service.getRun(run.id);active.status = "queued";
  const protectedFile = await f.upload("pending.txt", false, active.id);
  vi.spyOn(f.service,"fileUsageSnapshot").mockReturnValue({definitions:[saved],runs:[active]});
  expect(await f.manager.clearDirectory("runtime")).toEqual({deleted:105,skipped:1});
  await expect(f.files.resolve(protectedFile)).resolves.toBeDefined();
  await expect(f.files.resolve(unused)).resolves.toBeDefined();
  expect(await f.manager.clearDirectory("constants")).toEqual({deleted:1,skipped:1});
  await expect(f.files.resolve(constant)).resolves.toBeDefined();
  expect(await f.manager.clearDirectory("constants")).toEqual({deleted:0,skipped:1});
  await expect(f.manager.clearDirectory(undefined)).rejects.toMatchObject({code:"VALIDATION_FAILED"});
  await expect(f.manager.clearDirectory("../")).rejects.toMatchObject({code:"VALIDATION_FAILED"});
}, 30_000);
it("目录清理与保存互斥，磁盘删除异常向上传递", async () => {
  const f = await fixture(), constant = await f.upload("race.txt", true);
  const draft = emptyWorkflow();draft.nodes[0].outputs.push({name:"file",type:"file",defaultValue:constant});
  const deletion = f.manager.clearDirectory("constants"), saving = f.service.save(draft);
  await deletion;await expect(saving).rejects.toThrow("不存在");
  await f.upload();vi.spyOn(f.files,"remove").mockRejectedValue(new Error("磁盘删除失败"));
  await expect(f.manager.clearDirectory("runtime")).rejects.toThrow("磁盘删除失败");
});
