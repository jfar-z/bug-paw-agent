import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, opendir, rm, stat, writeFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import sharp from "sharp";
import { MEDIA_FORMATS, type MediaFile } from "../../shared/media-library-contracts";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import { MediaRepository, mediaName } from "./media-repository";

const execute = promisify(execFile);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** 服务只按数据库返回的文件标识访问正文，用户文件名始终是元数据。 */
export class MediaStorage {
  constructor(
    private readonly root: string,
    private readonly repo: MediaRepository,
  ) {}

  async recover() {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    // 持有实例锁且尚未接受上传。清理中断上传或已提交删除留下的独立目录。
    for await (const entry of await opendir(this.root)) {
      if (entry.isDirectory() && uuid.test(entry.name) && !this.repo.hasFile(entry.name))
        await this.discard(entry.name);
    }
  }

  async discard(id: string) {
    if (!uuid.test(id)) throw new DomainError("MEDIA_STORAGE_FAILED", "待清理媒体目录标识无效");
    try {
      await rm(join(this.root, id), { recursive: true, force: true });
    } catch (cause) {
      throw new DomainError("MEDIA_STORAGE_FAILED", "清理媒体正文目录失败，服务重启时将重新清理", undefined, {
        cause,
      });
    }
  }

  async save(libraryId: string, input: string, data: Buffer) {
    this.repo.library(libraryId);
    const name = mediaName(input, true);
    const ext = extname(name).toLowerCase();
    const mediaType = MEDIA_FORMATS[ext as keyof typeof MEDIA_FORMATS];
    if (!mediaType)
      throw new DomainError("MEDIA_FORMAT_UNSUPPORTED", "支持 JPEG、PNG、MP4 和 MP3，请检查文件扩展名");
    if (data.length > SYSTEM_LIMITS.mediaUploadBytes)
      throw new DomainError("MEDIA_UPLOAD_LIMIT", "媒体文件超过 50 MiB");
    const id = randomUUID();
    const dir = join(this.root, id);
    try {
      await mkdir(dir, { mode: 0o700 });
    } catch (cause) {
      throw new DomainError("MEDIA_STORAGE_FAILED", "创建媒体文件目录失败", undefined, { cause });
    }
    try {
      await writeFile(join(dir, "original"), data, { mode: 0o600 });
      const category = mediaType === "video/mp4" ? "video" : mediaType === "audio/mpeg" ? "audio" : "image";
      if (category === "image") {
        await imageThumbnail(data, mediaType, join(dir, "thumbnail.jpg"));
      } else {
        await validateRecording(dir, category, data);
      }
      return this.repo.add({ id, libraryId, name, category, mediaType, size: data.length, revision: 1 });
    } catch (error) {
      await this.discard(id);
      if (error instanceof DomainError) throw error;
      throw new DomainError("MEDIA_STORAGE_FAILED", "保存媒体原件、缩略图或索引失败", undefined, { cause: error });
    }
  }

  async resolve(file: MediaFile, thumbnail: boolean) {
    if (thumbnail && file.category === "audio") throw new DomainError("NOT_FOUND", "音频使用占位图，没有缩略图");
    const path = thumbnail ? "thumbnail.jpg" : "original";
    const absolutePath = join(this.root, file.id, path);
    try {
      const info = await stat(absolutePath);
      return {
        absolutePath,
        path: file.id + "/" + path,
        name: thumbnail ? path : file.name,
        mediaType: thumbnail ? "image/jpeg" : file.mediaType,
        size: info.size,
        modifiedAt: info.mtime.toISOString(),
      };
    } catch (cause) {
      throw new DomainError(
        "MEDIA_STORAGE_FAILED",
        thumbnail ? "读取媒体缩略图失败" : "读取媒体原件失败",
        undefined,
        { cause },
      );
    }
  }
}

async function imageThumbnail(data: Buffer, type: string, output: string) {
  let thumbnail: Buffer;
  try {
    const image = sharp(data, { failOn: "warning", limitInputPixels: 64_000_000 });
    const { format } = await image.metadata();
    if ("image/" + format !== type) throw new Error("格式不符");
    thumbnail = await image
      .rotate()
      .resize({ width: 400, height: 400, fit: "inside", withoutEnlargement: true })
      .jpeg()
      .toBuffer();
  } catch (cause) {
    throw new DomainError("MEDIA_FILE_INVALID", "图片解码失败，请检查格式、完整性及 6400 万像素限制", undefined, {
      cause,
    });
  }
  await writeFile(output, thumbnail);
}

async function validateRecording(dir: string, category: "video" | "audio", data: Buffer) {
  const video = category === "video";
  if (video && data.toString("ascii", 4, 8) !== "ftyp")
    throw new DomainError("MEDIA_FILE_INVALID", "缺少 MP4 文件头");
  // 指定本地容器格式和协议，禁止自动识别播放列表或从网络获取引用媒体。
  const args = [
    "-v",
    "error",
    "-nostdin",
    "-xerror",
    "-protocol_whitelist",
    "file",
    "-threads",
    "1",
    "-f",
    video ? "mov" : "mp3",
    "-i",
    join(dir, "original"),
    "-map",
    video ? "0:V:0" : "0:a:0",
  ];
  if (video) args.push("-map", "0:a:0?");
  args.push("-f", "null", "-");
  if (video)
    args.push(
      "-map",
      "0:V:0",
      "-frames:v",
      "1",
      "-vf",
      "scale=400:400:force_original_aspect_ratio=decrease",
      "-threads",
      "1",
      join(dir, "thumbnail.jpg"),
    );
  try {
    await execute("ffmpeg", args, {
      timeout: SYSTEM_LIMITS.mediaProcessingMs,
      killSignal: "SIGKILL",
      maxBuffer: 65536,
    });
    if (video && !(await stat(join(dir, "thumbnail.jpg"))).size) throw new Error("无可解码帧");
  } catch (cause) {
    if (
      cause instanceof Error &&
      "code" in cause &&
      cause.code === "ENOENT" &&
      "syscall" in cause &&
      cause.syscall === "spawn ffmpeg"
    ) {
      throw new DomainError("MEDIA_PROCESSING_FAILED", "服务缺少 FFmpeg，无法验证音视频", undefined, { cause });
    }
    throw new DomainError(
      "MEDIA_FILE_INVALID",
      "音视频解码或封面提取失败，请检查编码、文件完整性及 60 秒处理时限",
      undefined,
      { cause },
    );
  }
}
