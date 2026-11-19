/** 为新库和存量库提供相同的空备注初值。 */
export const mediaLibraryNoteMigration = {
  version: 10,
  sql: "ALTER TABLE media_libraries ADD COLUMN note TEXT NOT NULL DEFAULT ''",
} as const;
