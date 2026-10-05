import type { SqliteDatabase } from '@earendil-works/pi-durable/storage/sqlite';

/** This schema belongs only in the separately owned pi-workspaces.db. */
export async function initialize(database: SqliteDatabase): Promise<void> {
  // Logical quotas bound live content. Deleted pages are reused; this does not
  // promise that the physical database shrinks without an explicit VACUUM.
  await database.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA wal_autocheckpoint=1000; PRAGMA journal_size_limit=16777216;');
  await database.transaction(async (sql) => {
    const version = (await sql.get<{ user_version: number }>('PRAGMA user_version'))?.user_version ?? 0;
    if (version > 1) throw new Error('Workspace database schema is newer than this application');
    if (version === 1) return;
    await sql.exec(`
      CREATE TABLE workspaces (id TEXT PRIMARY KEY NOT NULL, root INTEGER, created INTEGER NOT NULL,
        bytes INTEGER NOT NULL DEFAULT 0, entry_count INTEGER NOT NULL DEFAULT 0, inode_count INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE inodes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
        kind TEXT NOT NULL CHECK(kind IN ('file','directory','symlink')), mode INTEGER NOT NULL,
        mtime INTEGER NOT NULL, size INTEGER NOT NULL CHECK(size>=0), data BLOB, target TEXT,
        UNIQUE(workspace_id,id),
        CHECK((kind='file' AND typeof(data)='blob' AND length(data)=size AND target IS NULL)
          OR (kind='directory' AND data IS NULL AND target IS NULL AND size=0)
          OR (kind='symlink' AND data IS NULL AND target IS NOT NULL))
      );
      CREATE TABLE entries (
        workspace_id TEXT NOT NULL, parent INTEGER NOT NULL, name TEXT NOT NULL CHECK(length(name)>0), inode INTEGER NOT NULL,
        PRIMARY KEY(workspace_id,parent,name),
        FOREIGN KEY(workspace_id,parent) REFERENCES inodes(workspace_id,id) ON DELETE CASCADE,
        FOREIGN KEY(workspace_id,inode) REFERENCES inodes(workspace_id,id) ON DELETE CASCADE
      );
      CREATE INDEX entries_inode ON entries(workspace_id,inode);
      CREATE INDEX inodes_workspace ON inodes(workspace_id);
      CREATE TRIGGER inode_insert AFTER INSERT ON inodes BEGIN
        UPDATE workspaces SET bytes=bytes+NEW.size,inode_count=inode_count+1 WHERE id=NEW.workspace_id;
      END;
      CREATE TRIGGER inode_update AFTER UPDATE OF size ON inodes BEGIN
        UPDATE workspaces SET bytes=bytes+NEW.size-OLD.size WHERE id=NEW.workspace_id;
      END;
      CREATE TRIGGER inode_delete AFTER DELETE ON inodes BEGIN
        UPDATE workspaces SET bytes=bytes-OLD.size,inode_count=inode_count-1 WHERE id=OLD.workspace_id;
      END;
      CREATE TRIGGER entry_insert AFTER INSERT ON entries BEGIN
        UPDATE workspaces SET entry_count=entry_count+1 WHERE id=NEW.workspace_id;
      END;
      CREATE TRIGGER entry_delete AFTER DELETE ON entries BEGIN
        UPDATE workspaces SET entry_count=entry_count-1 WHERE id=OLD.workspace_id;
      END;
      PRAGMA user_version=1;
    `);
  });
}
