'use strict';
/**
 * Persistent agent memory store backed by SQLite (better-sqlite3).
 *
 * Lives next to session.json + crypto.sqlite3 in the subnet client state
 * directory. Today this only tracks per-room "last read" timestamps so
 * `readAllNewMessages` can resume where it left off, but the file is named
 * generically (`memory.sqlite3`) so additional agent state can be added in
 * the same database later without another file.
 */

const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

class MemoryStore {
  /**
   * @param {string} storePath - Directory the memory database lives in.
   *   The directory is created if it doesn't exist.
   */
  constructor(storePath) {
    fs.mkdirSync(storePath, { recursive: true });
    this.dbPath = path.join(storePath, 'memory.sqlite3');
    this.db = new Database(this.dbPath);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS room_checkpoints (
        room_id      TEXT PRIMARY KEY,
        last_read_ts INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_memory (
        key        TEXT PRIMARY KEY,
        value      TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
  }

  /**
   * Get the last-read message timestamp (unix-ms) for a room, or null if
   * the room has never been checkpointed.
   */
  getCheckpoint(roomId) {
    const row = this.db
      .prepare('SELECT last_read_ts FROM room_checkpoints WHERE room_id = ?')
      .get(roomId);
    return row ? row.last_read_ts : null;
  }

  /**
   * Record that messages up to `ts` (unix-ms) have been read for a room.
   * Idempotent — only advances the checkpoint forward, never backward,
   * so re-running with stale data can't accidentally re-deliver messages.
   */
  setCheckpoint(roomId, ts) {
    this.db
      .prepare(
        `INSERT INTO room_checkpoints (room_id, last_read_ts, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(room_id) DO UPDATE SET
           last_read_ts = MAX(room_checkpoints.last_read_ts, excluded.last_read_ts),
           updated_at   = excluded.updated_at`,
      )
      .run(roomId, ts, Date.now());
  }

  // ── Agent scratchpad memory ───────────────────────────────────────────────
  //
  // A simple key/value store the agent can use to persist arbitrary state
  // across runs (e.g. notes about other participants, ongoing-task state,
  // long-running counters). Values are JSON-serialized on write and parsed
  // on read so callers can store any JSON-shaped data without thinking
  // about it. Plain strings round-trip fine.

  /**
   * Store a value under `key`. Overwrites any existing entry with the
   * same key. Value can be any JSON-serializable shape.
   */
  setMemory(key, value) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new Error('memory key must be a non-empty string');
    }
    const serialized = JSON.stringify(value);
    if (serialized === undefined) {
      throw new Error('memory value must be JSON-serializable');
    }
    this.db
      .prepare(
        `INSERT INTO agent_memory (key, value, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           value      = excluded.value,
           updated_at = excluded.updated_at`,
      )
      .run(key, serialized, Date.now());
  }

  /**
   * Retrieve a previously-stored value, or `null` if the key is unset.
   * Returns the parsed JSON value (so the caller gets the same shape
   * they wrote in).
   */
  getMemory(key) {
    const row = this.db
      .prepare('SELECT value FROM agent_memory WHERE key = ?')
      .get(key);
    if (!row) return null;
    try {
      return JSON.parse(row.value);
    } catch {
      return row.value;
    }
  }

  /**
   * List every memory entry, newest-first by `updated_at`. Each entry is
   * `{ key, value, updated_at }` with `value` already JSON-parsed.
   */
  listMemory() {
    return this.db
      .prepare(
        'SELECT key, value, updated_at FROM agent_memory ORDER BY updated_at DESC',
      )
      .all()
      .map(row => {
        let value;
        try {
          value = JSON.parse(row.value);
        } catch {
          value = row.value;
        }
        return { key: row.key, value, updated_at: row.updated_at };
      });
  }

  /**
   * Delete a memory entry. Returns true if a row was removed, false if
   * the key didn't exist.
   */
  deleteMemory(key) {
    const info = this.db
      .prepare('DELETE FROM agent_memory WHERE key = ?')
      .run(key);
    return info.changes > 0;
  }

  close() {
    try {
      this.db.close();
    } catch {}
  }
}

module.exports = { MemoryStore };
