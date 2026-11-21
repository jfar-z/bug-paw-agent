import { chmod, mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";

/**
 * 读取 UTF-8 JSON；文件尚未创建时返回 undefined。
 */
export async function readJson<T>(filePath: string): Promise<T | undefined> {
  try {
    const content = await readFile(filePath, "utf8");
    return JSON.parse(content) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

/**
 * 在目标目录内写入临时文件并原子替换，避免进程中断留下半份 JSON。
 */
export async function writeJsonAtomic(filePath: string, value: unknown, onPostCommitError?: (error: Error) => void): Promise<void> {
  const serializedValue = JSON.stringify(value);
  if (serializedValue === undefined) {
    throw new TypeError("JSON 内容不能序列化为 undefined");
  }

  const directory = dirname(filePath);
  const temporaryFile = join(directory, `.${basename(filePath)}.${randomUUID()}.tmp`);
  await mkdir(directory, { recursive: true, mode: 0o700 });

  let replaced = false;
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(temporaryFile, "wx", 0o600);
    await temporaryHandle.writeFile(`${serializedValue}\n`, "utf8");
    await temporaryHandle.sync();
    await temporaryHandle.close();
    temporaryHandle = undefined;

    await rename(temporaryFile, filePath);
    replaced = true;
    await chmod(filePath, 0o600);

    const directoryHandle = await open(directory, "r");
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } catch (error) {
    // 已替换的记录可被其他读取者观察到；事务调用方需保留其引用的资产并报告后置故障。
    if (replaced && onPostCommitError && error instanceof Error) {
      onPostCommitError(error);
      return;
    }
    await temporaryHandle?.close().catch(() => undefined);
    await rm(temporaryFile, { force: true }).catch(() => undefined);
    throw error;
  }
}
