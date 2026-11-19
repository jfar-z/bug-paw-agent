import { Type, type Static } from "typebox";

/** 工作台上传与重名预检共用的公开约束。 */
export const MEDIA_UPLOAD_BYTES = 50 * 1024 * 1024;
export const MEDIA_FORMATS = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
} as const;
export const MediaCategorySchema = Type.Union([
  Type.Literal("image"),
  Type.Literal("video"),
  Type.Literal("audio"),
]);
export type MediaCategory = Static<typeof MediaCategorySchema>;
export const MediaLibrarySchema = Type.Object({
  id: Type.String(),
  name: Type.String(),
  revision: Type.Integer(),
  fileCount: Type.Integer(),
});
export type MediaLibrary = Static<typeof MediaLibrarySchema>;
export const MediaFileSchema = Type.Object({
  id: Type.String(),
  libraryId: Type.String(),
  name: Type.String(),
  category: MediaCategorySchema,
  mediaType: Type.String(),
  size: Type.Integer(),
  revision: Type.Integer(),
});
export type MediaFile = Static<typeof MediaFileSchema>;
export type MediaRename = { name: string; revision: number };
export type MediaDeleteConfirmation = { name: string; revision: number; fileCount: number };
