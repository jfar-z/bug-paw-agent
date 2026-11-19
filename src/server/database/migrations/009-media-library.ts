/** 媒体正文留在受管文件目录，库内名称唯一性由数据库保证。 */
export const mediaLibraryMigration = {
  version: 9,
  sql: `
    CREATE TABLE media_libraries (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1
    ) STRICT;
    CREATE TABLE media_files (
      id TEXT PRIMARY KEY, libraryId TEXT NOT NULL REFERENCES media_libraries(id) ON DELETE CASCADE,
      name TEXT NOT NULL, nameKey TEXT NOT NULL, category TEXT NOT NULL CHECK(category IN ('image','video','audio')),
      mediaType TEXT NOT NULL, size INTEGER NOT NULL CHECK(size > 0), revision INTEGER NOT NULL DEFAULT 1,
      UNIQUE(libraryId, nameKey)
    ) STRICT;
  `,
} as const;
