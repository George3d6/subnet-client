'use strict';
/**
 * E2E-capable Matrix client with persistent device identity.
 *
 * Uses @matrix-org/matrix-sdk-crypto-nodejs (native Rust OlmMachine with SQLite)
 * for E2E encryption/decryption. Session state (userId, deviceId, accessToken)
 * is stored in a JSON file. Crypto state (Olm account, session keys) is stored
 * in a SQLite database — both in storePath.
 *
 * On first run: fresh login, keys uploaded to Synapse.
 * On subsequent runs: same device_id + access_token reused, crypto state loaded.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { signMessage } = require('./accountability');

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.subnet-client-state');

const {
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  RequestType,
  KeysUploadRequest,
  KeysQueryRequest,
  KeysClaimRequest,
  ToDeviceRequest,
} = require('@matrix-org/matrix-sdk-crypto-nodejs');

class E2EMatrixClient {
  /**
   * @param {object} opts
   * @param {string} opts.matrixUrl - Matrix homeserver URL
   * @param {string} opts.privateKey  - Ethereum private key (for accountability signing)
   * @param {string} [opts.storePath] - Directory for session + crypto state.
   *   Defaults to `$SUBNET_CLIENT_STATE_PATH` or `~/.subnet-client-state`
   *   so the location is stable across working directories.
   */
  constructor({ matrixUrl, privateKey, storePath }) {
    this.matrixUrl = matrixUrl.replace(/\/$/, '');
    this.privateKey = privateKey;
    this.storePath = path.resolve(
      storePath || process.env.SUBNET_CLIENT_STATE_PATH || DEFAULT_STATE_DIR,
    );
    this.sessionFile = path.join(this.storePath, 'session.json');
    this.cryptoPath = path.join(this.storePath, 'crypto.sqlite3');
    this.accessToken = null;
    this.userId = null;
    this.deviceId = null;
    this.olmMachine = null;
    this._keysUploaded = false;
  }

  // ── Session persistence ──────────────────────────────────────────────────────

  _loadSession() {
    try {
      if (fs.existsSync(this.sessionFile)) {
        return JSON.parse(fs.readFileSync(this.sessionFile, 'utf8'));
      }
    } catch {}
    return null;
  }

  _saveSession(data) {
    fs.mkdirSync(this.storePath, { recursive: true });
    fs.writeFileSync(this.sessionFile, JSON.stringify(data, null, 2));
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  async _fetch(urlPath, opts = {}) {
    const url = `${this.matrixUrl}${urlPath}`;
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    const res = await fetch(url, { ...opts, headers });
    let data;
    try { data = await res.json(); } catch { data = {}; }
    if (res.status === 429 && data.retry_after_ms) {
      const wait = Math.min(data.retry_after_ms + 500, 60_000);
      await new Promise(r => setTimeout(r, wait));
      return this._fetch(urlPath, opts);
    }
    if (!res.ok) throw new Error(data.error || `Matrix API error ${res.status} on ${urlPath}`);
    return data;
  }

  // ── Login & crypto init ──────────────────────────────────────────────────────

  /**
   * Login to Matrix and initialize the OlmMachine.
   * Reuses stored session if available; fresh login otherwise.
   */
  async login(username, password) {
    let session = this._loadSession();
    let isNewSession = false;

    if (session?.accessToken) {
      // Verify stored session is still valid
      this.accessToken = session.accessToken;
      this.userId = session.userId;
      this.deviceId = session.deviceId;
      try {
        await this._fetch('/_matrix/client/v3/account/whoami');
      } catch {
        // Token expired — fall through to fresh login
        session = null;
        this.accessToken = null;
      }
    }

    if (!session?.accessToken) {
      isNewSession = true;
      const data = await this._fetch('/_matrix/client/v3/login', {
        method: 'POST',
        body: JSON.stringify({
          type: 'm.login.password',
          user: username,
          password,
          initial_device_display_name: 'subnet-client',
        }),
      });
      this.accessToken = data.access_token;
      this.userId = data.user_id;
      this.deviceId = data.device_id;
      session = { userId: this.userId, deviceId: this.deviceId, accessToken: this.accessToken };
      this._saveSession(session);
    }

    // Initialize OlmMachine (loads from SQLite if it exists, creates fresh otherwise)
    this.olmMachine = await OlmMachine.initialize(
      new UserId(this.userId),
      new DeviceId(this.deviceId),
      this.cryptoPath,
    );

    // Upload device keys if this is a new session or if keys haven't been uploaded
    if (isNewSession) {
      await this._uploadKeys();
    }

    return { userId: this.userId, deviceId: this.deviceId };
  }

  // ── Key management ───────────────────────────────────────────────────────────

  /**
   * Process all pending outgoing requests from OlmMachine.
   * Handles key uploads, key queries, key claims, and to-device sends.
   */
  async _processOutgoing() {
    const requests = await this.olmMachine.outgoingRequests();
    for (const req of requests) {
      try {
        await this._handleOutgoingRequest(req);
      } catch (e) {
        console.warn('[E2E] outgoing request failed:', e.message);
      }
    }
  }

  async _handleOutgoingRequest(req) {
    let response;
    switch (req.type) {
      case RequestType.KeysUpload:
        response = await this._fetch('/_matrix/client/v3/keys/upload', {
          method: 'POST',
          body: req.body,
        });
        await this.olmMachine.markRequestAsSent(req.id, req.type, JSON.stringify(response));
        this._keysUploaded = true;
        break;

      case RequestType.KeysQuery:
        response = await this._fetch('/_matrix/client/v3/keys/query', {
          method: 'POST',
          body: req.body,
        });
        await this.olmMachine.markRequestAsSent(req.id, req.type, JSON.stringify(response));
        break;

      case RequestType.KeysClaim:
        response = await this._fetch('/_matrix/client/v3/keys/claim', {
          method: 'POST',
          body: req.body,
        });
        await this.olmMachine.markRequestAsSent(req.id, req.type, JSON.stringify(response));
        break;

      case RequestType.ToDevice: {
        const parsed = JSON.parse(req.body);
        const eventType = encodeURIComponent(parsed.event_type);
        const txnId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
        response = await this._fetch(`/_matrix/client/v3/sendToDevice/${eventType}/${txnId}`, {
          method: 'PUT',
          body: JSON.stringify({ messages: parsed.messages }),
        });
        await this.olmMachine.markRequestAsSent(req.id, req.type, JSON.stringify(response));
        break;
      }

      case RequestType.SignatureUpload:
        response = await this._fetch('/_matrix/client/v3/keys/signatures/upload', {
          method: 'POST',
          body: req.body,
        });
        await this.olmMachine.markRequestAsSent(req.id, req.type, JSON.stringify(response));
        break;

      default:
        // Unknown request type — skip
        break;
    }
  }

  async _uploadKeys() {
    await this._processOutgoing();
  }

  /**
   * Do a one-shot /sync to retrieve to-device events and process key exchanges.
   * This is needed before reading from or sending to encrypted rooms.
   */
  async _syncOnce(since) {
    const params = new URLSearchParams({ timeout: '0', filter: JSON.stringify({
      room: { timeline: { limit: 0 }, state: { limit: 0 }, ephemeral: { limit: 0 } },
      presence: { limit: 0 },
    }) });
    if (since) params.set('since', since);

    const sync = await this._fetch(`/_matrix/client/v3/sync?${params}`);

    const toDeviceEvents = sync.to_device?.events || [];
    const deviceChanges = sync.device_lists || {};
    const oneTimeKeyCounts = sync.device_one_time_keys_count || {};
    const unusedFallback = sync.device_unused_fallback_key_types || [];

    if (toDeviceEvents.length > 0 || Object.keys(deviceChanges).length > 0) {
      await this.olmMachine.receiveSyncChanges(
        JSON.stringify(toDeviceEvents),
        deviceChanges,
        oneTimeKeyCounts,
        unusedFallback,
        sync.next_batch,
      );
      await this._processOutgoing();
    }

    return sync.next_batch;
  }

  // ── Room membership ──────────────────────────────────────────────────────────

  async _getRoomMembers(roomId) {
    const data = await this._fetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`);
    return (data.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key);
  }

  async _isRoomEncrypted(roomId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
      );
      return !!data.algorithm;
    } catch {
      return false;
    }
  }

  // ── Read messages ────────────────────────────────────────────────────────────

  /**
   * Compute a unix-ms cutoff from `sinceMinsAgo` (minutes ago).
   * Returns null when not set.
   */
  _computeCutoffMs(opts) {
    if (opts.sinceMinsAgo !== undefined && opts.sinceMinsAgo !== null) {
      return Date.now() - Number(opts.sinceMinsAgo) * 60_000;
    }
    return null;
  }

  /**
   * Read messages from a room with automatic E2E decryption.
   *
   * When `sinceMinsAgo` is set, paginates backwards (up to `maxPages`) until
   * messages older than the cutoff are found. The `limit` is the per-page
   * batch size in that mode.
   *
   * @param {string} roomId
   * @param {object} [opts]
   * @param {number} [opts.limit=50] - Per-page batch size
   * @param {string} [opts.from] - Matrix pagination token
   * @param {number} [opts.sinceMinsAgo] - Only return messages from the last N minutes
   * @param {number} [opts.maxPages=20] - Pagination safety bound when `sinceMinsAgo` is set
   */
  async readMessages(roomId, opts = {}) {
    const limit = opts.limit || 50;
    const cutoffMs = this._computeCutoffMs(opts);
    const maxPages = cutoffMs !== null ? (opts.maxPages || 20) : 1;
    const encrypted = await this._isRoomEncrypted(roomId);

    if (encrypted) {
      // Sync to get any pending room keys
      await this._syncOnce();
      await this._processOutgoing();
    }

    const allRawNewestFirst = [];
    let from = opts.from;
    let end = null;
    let pagesFetched = 0;

    while (pagesFetched < maxPages) {
      let reqPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`;
      if (from) reqPath += `&from=${encodeURIComponent(from)}`;

      const data = await this._fetch(reqPath);
      const chunk = data.chunk || [];
      end = data.end || end;

      if (chunk.length === 0) break;
      allRawNewestFirst.push(...chunk);
      pagesFetched++;

      if (!data.end) break;
      if (cutoffMs !== null) {
        const oldest = chunk[chunk.length - 1];
        if (oldest && oldest.origin_server_ts < cutoffMs) break;
      }
      from = data.end;
    }

    const events = allRawNewestFirst.reverse();

    const result = [];
    const history = [];

    for (const event of events) {
      if (cutoffMs !== null && event.origin_server_ts < cutoffMs) continue;
      let msgEvent = event;

      // Decrypt if needed
      if (event.type === 'm.room.encrypted' && encrypted) {
        try {
          const decryptedJson = await this.olmMachine.decryptRoomEvent(
            JSON.stringify(event),
            new RoomId(roomId),
          );
          const decrypted = JSON.parse(decryptedJson.event);
          msgEvent = { ...event, type: decrypted.type, content: decrypted.content };
        } catch (e) {
          // Can't decrypt — skip or mark as undecryptable
          result.push({
            event_id: event.event_id,
            sender: event.sender,
            body: '[unable to decrypt]',
            timestamp: event.origin_server_ts,
            accountability: { signed: false, warning: 'Unable to decrypt: ' + e.message },
          });
          continue;
        }
      }

      if (msgEvent.type !== 'm.room.message' || msgEvent.content?.msgtype !== 'm.text') continue;

      const sender = msgEvent.sender;
      const body = msgEvent.content.body;
      const acc = msgEvent.content['ai.abliterate.accountability'];

      const entry = {
        event_id: msgEvent.event_id,
        sender,
        body,
        timestamp: event.origin_server_ts,
        accountability: acc
          ? { signed: true, prev_conv: acc.prev_conv, with_reply: acc.with_reply, valid: null }
          : { signed: false, warning: 'Unsigned message' },
      };

      history.push({ sender, body });
      result.push(entry);
    }

    return { messages: result, end };
  }

  /**
   * Read messages from every room the user has joined.
   *
   * Accepts the same options as `readMessages` (limit, since, sinceMsAgo,
   * maxPages). Returns a map of roomId -> per-room result. Failures on a
   * single room are captured per-room and do not abort the others.
   */
  async readAllMessages(opts = {}) {
    const roomIds = await this.listJoinedRooms();
    const rooms = {};
    for (const roomId of roomIds) {
      try {
        rooms[roomId] = await this.readMessages(roomId, opts);
      } catch (e) {
        rooms[roomId] = { messages: [], error: e.message };
      }
    }
    return { rooms };
  }

  // ── Send messages ────────────────────────────────────────────────────────────

  /**
   * Send a signed message to a room with automatic E2E encryption.
   */
  async sendMessage(roomId, text, opts = {}) {
    const historyLimit = opts.historyLimit || 50;
    const encrypted = await this._isRoomEncrypted(roomId);

    // Build accountability signature
    const historyData = await this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${historyLimit}`,
    );
    const historyEvents = (historyData.chunk || [])
      .filter(e => e.type === 'm.room.message' && e.content?.msgtype === 'm.text')
      .reverse()
      .map(e => ({ sender: e.sender, body: e.content.body }));

    const signed = await signMessage(this.privateKey, historyEvents, text, this.userId);
    const content = {
      msgtype: 'm.text',
      body: text,
      'ai.abliterate.accountability': {
        prev_conv: signed.prev_conv_sign,
        with_reply: signed.with_reply_sign,
      },
    };

    const txnId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;

    if (encrypted) {
      await this._ensureRoomKeysShared(roomId);

      const encryptedContent = await this.olmMachine.encryptRoomEvent(
        new RoomId(roomId),
        'm.room.message',
        JSON.stringify(content),
      );

      const result = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/${txnId}`,
        { method: 'PUT', body: encryptedContent },
      );
      return {
        event_id: result.event_id,
        accountability: { message: signed.message, message_with_sign: signed.message_with_sign },
      };
    } else {
      const result = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
        { method: 'PUT', body: JSON.stringify(content) },
      );
      return {
        event_id: result.event_id,
        accountability: { message: signed.message, message_with_sign: signed.message_with_sign },
      };
    }
  }

  /**
   * Ensure room keys are shared with all current room members.
   */
  async _ensureRoomKeysShared(roomId) {
    const members = await this._getRoomMembers(roomId);
    await this.olmMachine.updateTrackedUsers(members.map(m => new UserId(m)));
    await this._processOutgoing(); // KeysQuery to get member devices

    const { EncryptionSettings, HistoryVisibility, EncryptionAlgorithm } =
      require('@matrix-org/matrix-sdk-crypto-nodejs');

    const settings = new EncryptionSettings();

    const toDeviceRequests = await this.olmMachine.shareRoomKey(
      new RoomId(roomId),
      members.map(m => new UserId(m)),
      settings,
    );

    for (const req of toDeviceRequests) {
      await this._handleOutgoingRequest(req);
    }

    // Process any additional outgoing after sharing
    await this._processOutgoing();
  }

  // ── Misc Matrix API helpers ──────────────────────────────────────────────────

  async listPublicRooms() {
    return this._fetch('/_matrix/client/v3/publicRooms');
  }

  /**
   * List rooms the current user has joined.
   * @returns {Promise<string[]>}
   */
  async listJoinedRooms() {
    const data = await this._fetch('/_matrix/client/v3/joined_rooms');
    return data.joined_rooms || [];
  }

  async joinRoom(roomId) {
    return this._fetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      body: '{}',
    });
  }

  async sync(opts = {}) {
    const timeout = opts.timeout || 30000;
    let reqPath = `/_matrix/client/v3/sync?timeout=${timeout}`;
    if (opts.since) reqPath += `&since=${encodeURIComponent(opts.since)}`;
    return this._fetch(reqPath);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  async close() {
    if (this.olmMachine) {
      try { await this.olmMachine.close(); } catch {}
      this.olmMachine = null;
    }
  }
}

module.exports = { E2EMatrixClient };
