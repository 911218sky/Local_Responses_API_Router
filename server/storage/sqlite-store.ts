import { Database } from "bun:sqlite"
import * as fs from "node:fs"
import * as path from "node:path"
import { objectFromUnknown } from "../core/types"

process.umask(0o077)

class RouterDatabase {
  readonly database: Database
  private transactionDepth = 0

  constructor(dataDirectory: string) {
    fs.mkdirSync(dataDirectory, { recursive: true, mode: 0o700 })
    fs.chmodSync(dataDirectory, 0o700)
    const databasePath = path.join(dataDirectory, "router.sqlite")
    this.database = new Database(databasePath, { create: true })
    this.database.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;
            PRAGMA busy_timeout = 5000;
            CREATE TABLE IF NOT EXISTS metadata (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value_json TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS request_logs (
                id TEXT PRIMARY KEY,
                created_at TEXT NOT NULL,
                session_id TEXT,
                data_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS request_logs_created_at ON request_logs(created_at DESC);
            CREATE INDEX IF NOT EXISTS request_logs_session_id ON request_logs(session_id);
            CREATE TABLE IF NOT EXISTS response_contexts (
                response_id TEXT PRIMARY KEY,
                updated_at TEXT NOT NULL,
                session_id TEXT,
                log_id TEXT,
                data_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS response_contexts_updated_at ON response_contexts(updated_at DESC);
            CREATE INDEX IF NOT EXISTS response_contexts_session_id ON response_contexts(session_id);
            CREATE INDEX IF NOT EXISTS response_contexts_log_id ON response_contexts(log_id);
        `)
    const privateFiles = [
      databasePath,
      `${databasePath}-wal`,
      `${databasePath}-shm`,
      path.join(dataDirectory, "config.json"),
      path.join(dataDirectory, "request-logs.json"),
      path.join(dataDirectory, "response-contexts.json"),
    ]
    for (const filePath of privateFiles) {
      if (fs.existsSync(filePath)) fs.chmodSync(filePath, 0o600)
    }
  }

  migrate(name: string, migration: () => void): void {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const row: unknown = this.database.query("SELECT value FROM metadata WHERE key = ?").get(name)
      if (!stringColumn(row, "value")) {
        migration()
        this.database.run("INSERT INTO metadata (key, value) VALUES (?, ?)", [name, new Date().toISOString()])
      }
      this.database.exec("COMMIT")
    } catch (error) {
      this.database.exec("ROLLBACK")
      throw error
    }
  }

  setting(key: string): unknown {
    const row: unknown = this.database.query("SELECT value_json FROM settings WHERE key = ?").get(key)
    return parseJson(stringColumn(row, "value_json"))
  }

  saveSetting(key: string, value: unknown): void {
    this.saveSettingAt(key, value, new Date().toISOString())
  }

  saveSettingIfNewer(key: string, value: unknown, updatedAt: string): void {
    this.database.run(
      `
            INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
            WHERE excluded.updated_at > settings.updated_at
        `,
      [key, JSON.stringify(value), updatedAt],
    )
  }

  runTransaction(action: () => void): void {
    if (this.transactionDepth > 0) {
      action()
      return
    }
    this.transactionDepth += 1
    try {
      const transaction = this.database.transaction(action)
      transaction()
    } finally {
      this.transactionDepth -= 1
    }
  }

  private saveSettingAt(key: string, value: unknown, updatedAt: string): void {
    this.database.run(
      `
            INSERT INTO settings (key, value_json, updated_at) VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at
        `,
      [key, JSON.stringify(value), updatedAt],
    )
  }

  logs(): unknown[] {
    return jsonRows(this.database.query("SELECT data_json FROM request_logs ORDER BY created_at DESC").all())
  }

  log(id: string): unknown {
    const row: unknown = this.database.query("SELECT data_json FROM request_logs WHERE id = ?").get(id)
    return parseJson(stringColumn(row, "data_json"))
  }

  saveLog(id: string, createdAt: string, sessionId: string | null, value: unknown): void {
    this.database.run(
      `
            INSERT INTO request_logs (id, created_at, session_id, data_json) VALUES (?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET created_at = excluded.created_at, session_id = excluded.session_id, data_json = excluded.data_json
        `,
      [id, createdAt, sessionId, JSON.stringify(value)],
    )
  }

  deleteLog(id: string): void {
    this.database.run("DELETE FROM request_logs WHERE id = ?", [id])
  }

  deleteLogsBySession(sessionId: string): void {
    this.database.run("DELETE FROM request_logs WHERE session_id = ?", [sessionId])
  }

  clearLogs(): void {
    this.database.run("DELETE FROM request_logs")
  }

  clearTrafficData(): void {
    this.runTransaction(() => {
      this.database.run("DELETE FROM request_logs")
      this.database.run("DELETE FROM response_contexts")
    })
  }

  trimLogs(maxEntries: number): void {
    this.database.run(
      "DELETE FROM request_logs WHERE id NOT IN (SELECT id FROM request_logs ORDER BY created_at DESC LIMIT ?)",
      [maxEntries],
    )
  }

  contexts(): unknown[] {
    return jsonRows(this.database.query("SELECT data_json FROM response_contexts ORDER BY updated_at DESC").all())
  }

  context(responseId: string): unknown {
    const row: unknown = this.database
      .query("SELECT data_json FROM response_contexts WHERE response_id = ?")
      .get(responseId)
    return parseJson(stringColumn(row, "data_json"))
  }

  saveContext(
    responseId: string,
    updatedAt: string,
    sessionId: string | null,
    logId: string | null,
    value: unknown,
  ): void {
    this.database.run(
      `
            INSERT INTO response_contexts (response_id, updated_at, session_id, log_id, data_json) VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(response_id) DO UPDATE SET updated_at = excluded.updated_at, session_id = excluded.session_id, log_id = excluded.log_id, data_json = excluded.data_json
            WHERE excluded.updated_at >= response_contexts.updated_at
        `,
      [responseId, updatedAt, sessionId, logId, JSON.stringify(value)],
    )
  }

  deleteContext(responseId: string): void {
    this.database.run("DELETE FROM response_contexts WHERE response_id = ?", [responseId])
  }

  deleteContextsByLogIds(logIds: readonly string[]): void {
    const statement = this.database.prepare("DELETE FROM response_contexts WHERE log_id = ?")
    this.runTransaction(() => {
      for (const id of logIds) statement.run(id)
    })
  }

  deleteContextsBySession(sessionId: string): void {
    this.database.run("DELETE FROM response_contexts WHERE session_id = ?", [sessionId])
  }

  clearContexts(): void {
    this.database.run("DELETE FROM response_contexts")
  }

  trimContexts(maxEntries: number): string[] {
    const rows: unknown = this.database
      .query(
        "SELECT response_id FROM response_contexts WHERE response_id NOT IN (SELECT response_id FROM response_contexts ORDER BY updated_at DESC LIMIT ?)",
      )
      .all(maxEntries)
    const responseIds = Array.isArray(rows)
      ? rows
          .map((row) => objectFromUnknown(row).response_id)
          .filter((responseId): responseId is string => typeof responseId === "string")
      : []
    this.database.run(
      "DELETE FROM response_contexts WHERE response_id NOT IN (SELECT response_id FROM response_contexts ORDER BY updated_at DESC LIMIT ?)",
      [maxEntries],
    )
    return responseIds
  }
}

function jsonRows(value: unknown): unknown[] {
  if (!Array.isArray(value)) return []
  return value.map((row) => parseJson(stringColumn(row, "data_json"))).filter((item) => item !== undefined)
}

function stringColumn(value: unknown, key: string): string {
  const column = objectFromUnknown(value)[key]
  return typeof column === "string" ? column : ""
}

function parseJson(value: string): unknown {
  if (!value) return undefined
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

export { RouterDatabase }
