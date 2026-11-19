import { randomUUID } from "node:crypto";
import { extname } from "node:path";
import { MEDIA_LIBRARY_NOTE_MAX_LENGTH } from "../../shared/media-library-contracts";
import type {
  MediaFile,
  MediaLibrary,
  MediaCategory,
  MediaDeleteConfirmation,
} from "../../shared/media-library-contracts";
import { DomainError } from "../core/errors";
import { SYSTEM_LIMITS } from "../core/limits";
import type { Database } from "../database/database";

const libraries =
  "SELECT l.*, (SELECT count(*) FROM media_files f WHERE f.libraryId=l.id) AS fileCount FROM media_libraries l";
const files = "SELECT id,libraryId,name,category,mediaType,size,revision FROM media_files";

export function mediaName(input: unknown, file = false): string {
  const name = typeof input === "string" ? input.trim().normalize("NFC") : "";
  if (!name || name.length > 200 || /[\\/:*?"<>|\u0000-\u001f\u007f]/u.test(name) || /^\.+$/.test(name)) {
    throw new DomainError("VALIDATION_FAILED", "名称须为 1 至 200 个字符，不能包含路径分隔符、控制字符或非法标点", { field: "name" });
  }
  if (file && (!extname(name) || !name.slice(0, -extname(name).length).trim())) {
    throw new DomainError("VALIDATION_FAILED", "请填写主文件名并保留扩展名");
  }
  return name;
}

function checkRevision(expected: unknown, actual: number) {
  if (expected !== actual) throw new DomainError("VERSION_CONFLICT", "媒体库或文件已变化，请刷新后重新确认");
}

/** 在写事务内校验名称和确认范围，使并发请求共享同一事实源。 */
export class MediaRepository {
  constructor(private readonly db: Database) {}

  list() {
    return this.db.read<MediaLibrary>(libraries + " ORDER BY l.rowid");
  }

  library(id: string) {
    const row = this.db.readOne<MediaLibrary>(libraries + " WHERE l.id=?", [id]);
    if (!row) throw new DomainError("NOT_FOUND", "媒体库不存在");
    return row;
  }

  create(input: unknown) {
    const name = mediaName(input);
    return this.db.transaction(() => {
      if (this.list().length >= SYSTEM_LIMITS.mediaLibraries)
        throw new DomainError("MEDIA_UPLOAD_LIMIT", "媒体库数量达到上限");
      const id = randomUUID();
      this.db.write("INSERT INTO media_libraries(id,name) VALUES (?,?)", [id, name]);
      return this.library(id);
    });
  }

  updateLibrary(id: string, input: unknown, revision: unknown, rawNote?: unknown) {
    const name = mediaName(input);
    if (rawNote !== undefined && typeof rawNote !== "string")
      throw new DomainError("VALIDATION_FAILED", "媒体库备注须为纯文本", { field: "note" });
    const note = rawNote?.trim();
    if (note !== undefined && Array.from(note).length > MEDIA_LIBRARY_NOTE_MAX_LENGTH)
      throw new DomainError("VALIDATION_FAILED", "媒体库备注最多 500 个字符", { field: "note" });
    return this.db.transaction(() => {
      const current = this.library(id);
      checkRevision(revision, current.revision);
      // 旧客户端只提交库名，须在版本校验后沿用已保存的备注。
      const nextNote = note ?? current.note;
      if (current.name === name && current.note === nextNote) return current;
      this.db.write("UPDATE media_libraries SET name=?, note=?, revision=revision+1 WHERE id=?", [
        name, nextNote, id,
      ]);
      return this.library(id);
    });
  }

  removeLibrary(id: string, confirmation: Partial<MediaDeleteConfirmation>) {
    return this.db.transaction(() => {
      const current = this.library(id);
      checkRevision(confirmation.revision, current.revision);
      if (confirmation.name !== current.name || confirmation.fileCount !== current.fileCount) {
        throw new DomainError("VALIDATION_FAILED", "删除确认须与当前库名及文件数一致");
      }
      const ids = this.db.read<{ id: string }>("SELECT id FROM media_files WHERE libraryId=?", [id]);
      this.db.write("DELETE FROM media_libraries WHERE id=?", [id]);
      return ids.map((item) => item.id);
    });
  }

  listFiles(id: string, category?: MediaCategory) {
    this.library(id);
    return this.db.read<MediaFile>(
      files + " WHERE libraryId=?" + (category ? " AND category=?" : "") + " ORDER BY rowid DESC",
      category ? [id, category] : [id],
    );
  }

  file(libraryId: string, id: string) {
    const row = this.db.readOne<MediaFile>(files + " WHERE libraryId=? AND id=?", [libraryId, id]);
    if (!row) throw new DomainError("NOT_FOUND", "媒体文件不在指定库中");
    return row;
  }

  hasFile(id: string) {
    return !!this.db.readOne("SELECT id FROM media_files WHERE id=?", [id]);
  }

  available(id: string, name: string, exclude = "") {
    return !this.db.readOne("SELECT id FROM media_files WHERE libraryId=? AND nameKey=? AND id<>?", [
      id,
      name.toLowerCase(),
      exclude,
    ]);
  }

  private checkName(id: string, name: string, exclude?: string) {
    if (!this.available(id, name, exclude))
      throw new DomainError("MEDIA_NAME_CONFLICT", "当前库已存在同名文件，请修改文件名");
  }

  private touch(id: string) {
    this.db.write("UPDATE media_libraries SET revision=revision+1 WHERE id=?", [id]);
  }

  add(item: MediaFile) {
    return this.db.transaction(() => {
      const { id, libraryId, name, category, mediaType, size } = item;
      if (this.library(libraryId).fileCount >= SYSTEM_LIMITS.mediaFilesPerLibrary)
        throw new DomainError("MEDIA_UPLOAD_LIMIT", "库内文件数量达到上限");
      this.checkName(libraryId, name);
      this.db.write(
        "INSERT INTO media_files(id,libraryId,name,nameKey,category,mediaType,size) VALUES(?,?,?,?,?,?,?)",
        [id, libraryId, name, name.toLowerCase(), category, mediaType, size],
      );
      this.touch(libraryId);
      return this.file(libraryId, id);
    });
  }

  renameFile(lib: string, id: string, input: unknown, revision: unknown) {
    const name = mediaName(input, true);
    return this.db.transaction(() => {
      const current = this.file(lib, id);
      checkRevision(revision, current.revision);
      if (name === current.name) return current;
      if (extname(name).toLowerCase() !== extname(current.name).toLowerCase())
        throw new DomainError("VALIDATION_FAILED", "文件改名须保留原扩展名");
      this.checkName(lib, name, id);
      this.db.write("UPDATE media_files SET name=?,nameKey=?,revision=revision+1 WHERE id=?", [
        name,
        name.toLowerCase(),
        id,
      ]);
      this.touch(lib);
      return this.file(lib, id);
    });
  }

  removeFile(lib: string, id: string, revision: unknown) {
    this.db.transaction(() => {
      checkRevision(revision, this.file(lib, id).revision);
      this.db.write("DELETE FROM media_files WHERE id=?", [id]);
      this.touch(lib);
    });
  }
}
