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

// Field name used when sending. Reads accept any of the legacy names below
// for backwards compatibility.
const ACCOUNTABILITY_FIELD = 'xyz.vanadium.accountability';
const LEGACY_ACCOUNTABILITY_FIELDS = [
  'xyz.vanadium.accountability',
  'ai.subnet.accountability',
  'ai.abliterate.accountability',
];

function readAccountability(content) {
  if (!content) return null;
  for (const field of LEGACY_ACCOUNTABILITY_FIELDS) {
    if (content[field]) return content[field];
  }
  return null;
}

const {
  OlmMachine,
  UserId,
  DeviceId,
  RoomId,
  DeviceLists,
  RequestType,
  EncryptionSettings,
  HistoryVisibility,
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
    if (res.status === 429) {
      const headerSecs = Number(res.headers.get('retry-after'));
      const headerMs = Number.isFinite(headerSecs) ? headerSecs * 1000 : 0;
      const bodyMs = Number(data.retry_after_ms) || 0;
      const waitMs = Math.min(Math.max(headerMs, bodyMs, 1000) + 500, 60_000);
      await new Promise(r => setTimeout(r, waitMs));
      return this._fetch(urlPath, opts);
    }
    if (!res.ok) {
      const err = new Error(data.error || `Matrix API error ${res.status} on ${urlPath}`);
      err.status = res.status;
      err.errcode = data.errcode;
      throw err;
    }
    return data;
  }

  // ── Login & crypto init ──────────────────────────────────────────────────────

  /**
   * Login to Matrix and initialize the OlmMachine.
   *
   * Three states:
   *   1. Stored session is still valid (whoami succeeds) → reuse it as-is.
   *   2. Stored session's access token is dead but we know our device_id →
   *      re-login with `device_id` set so Synapse keeps the same device,
   *      preserving the SQLite crypto store.
   *   3. No prior session at all → fresh login (Synapse mints a new device).
   *
   * The crypto store at `cryptoPath` is permanently bound to the
   * (user_id, device_id) tuple it was first initialized with. If we ever
   * reach OlmMachine.initialize with a *different* device_id than the one
   * the SQLite was created for, the binding throws "the account in the
   * store doesn't match the account in the constructor". This flow exists
   * to make sure that never happens during normal operation.
   */
  async login(username, password) {
    const session = this._loadSession();
    const cryptoStoreExists = fs.existsSync(this.cryptoPath);
    const priorDeviceId = session?.deviceId || null;
    let usedStoredToken = false;
    let isFreshDevice = false;

    // ── 1. Try the stored access token first.
    if (session?.accessToken) {
      this.accessToken = session.accessToken;
      this.userId = session.userId;
      this.deviceId = session.deviceId;
      try {
        await this._fetch('/_matrix/client/v3/account/whoami');
        usedStoredToken = true;
      } catch (e) {
        // Only treat hard-auth failures as "token is dead". Anything else
        // (network blip, 429, 5xx) is transient — propagate it so we never
        // accidentally rotate the device identity over a temporary failure.
        // That rotation is exactly what poisons the SQLite crypto store.
        const tokenDead =
          e.status === 401 ||
          e.status === 403 ||
          e.errcode === 'M_UNKNOWN_TOKEN' ||
          e.errcode === 'M_MISSING_TOKEN' ||
          e.errcode === 'M_UNKNOWN_ACCESS_TOKEN';
        if (!tokenDead) throw e;
        this.accessToken = null;
      }
    }

    // ── 2. If we couldn't reuse the stored token, log in again — but
    //      preserve the device identity when we know it.
    if (!usedStoredToken) {
      // Defensive guard: a SQLite store with no session.json means we
      // can't tell which device the store was created for. Doing a fresh
      // login here would mint a new device and the very next
      // OlmMachine.initialize would fail with a cryptic
      // "account in store doesn't match" error. Fail loudly instead.
      if (cryptoStoreExists && !priorDeviceId) {
        throw new Error(
          `Crypto store exists at ${this.cryptoPath} but session.json is missing — ` +
          `cannot determine which device this store belongs to. Delete the entire ` +
          `state directory (${this.storePath}) to recover. You will lose decryption ` +
          `keys for past encrypted messages.`,
        );
      }

      isFreshDevice = !priorDeviceId;

      const loginBody = {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: username },
        password,
        initial_device_display_name: 'subnet-client',
      };
      // Reuse the existing device when we have one. Synapse will rotate
      // the access token but keep the device_id and its uploaded keys.
      if (priorDeviceId) loginBody.device_id = priorDeviceId;

      const data = await this._fetch('/_matrix/client/v3/login', {
        method: 'POST',
        body: JSON.stringify(loginBody),
      });
      this.accessToken = data.access_token;
      this.userId = data.user_id;
      this.deviceId = data.device_id;

      // Sanity check: if we asked the server to reuse our device but it
      // gave us a different one, the SQLite store would be unusable. Bail
      // out before we touch OlmMachine so we don't make things worse.
      if (priorDeviceId && this.deviceId !== priorDeviceId) {
        throw new Error(
          `Login returned device_id ${this.deviceId} but we requested ${priorDeviceId}. ` +
          `The existing crypto store at ${this.cryptoPath} cannot be used with a ` +
          `different device. Delete ${this.storePath} to recover (you will lose ` +
          `decryption keys for past encrypted messages).`,
        );
      }

      this._saveSession({
        userId: this.userId,
        deviceId: this.deviceId,
        accessToken: this.accessToken,
      });
    }

    // Initialize OlmMachine (loads from SQLite if it exists, creates fresh
    // otherwise). By construction, (this.userId, this.deviceId) now matches
    // whatever the SQLite was created for — either because we reused the
    // stored session, or because we forced /login to honor priorDeviceId.
    this.olmMachine = await OlmMachine.initialize(
      new UserId(this.userId),
      new DeviceId(this.deviceId),
      this.cryptoPath,
    );

    // Upload device keys only on a genuinely new device. Refreshing an
    // access token on an existing device leaves the keys in place on the
    // server — the local OlmMachine knows they're already uploaded.
    if (isFreshDevice) {
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
    const changedUsers = (sync.device_lists?.changed || []).map(u => new UserId(u));
    const leftUsers = (sync.device_lists?.left || []).map(u => new UserId(u));
    const deviceLists = new DeviceLists(changedUsers, leftUsers);
    const oneTimeKeyCounts = sync.device_one_time_keys_count || {};
    const unusedFallback = sync.device_unused_fallback_key_types || [];

    // Always call receiveSyncChanges — the OlmMachine relies on the OTK count
    // and unused-fallback-key snapshot to know when to top up keys, even when
    // there are no to-device events or device list changes.
    await this.olmMachine.receiveSyncChanges(
      JSON.stringify(toDeviceEvents),
      deviceLists,
      oneTimeKeyCounts,
      unusedFallback,
    );
    await this._processOutgoing();

    return sync.next_batch;
  }

  // ── Room membership ──────────────────────────────────────────────────────────

  async _getRoomMembers(roomId) {
    const data = await this._fetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/members`);
    return (data.chunk || [])
      .filter(e => e.content?.membership === 'join')
      .map(e => e.state_key);
  }

  /**
   * Fetch the room's m.room.history_visibility setting and map it to the
   * OlmMachine HistoryVisibility enum. Defaults to Shared (the Matrix spec
   * default) when the state event is missing.
   */
  async _getRoomHistoryVisibility(roomId) {
    let raw = 'shared';
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.history_visibility`,
      );
      if (data.history_visibility) raw = data.history_visibility;
    } catch (e) {
      if (e.status !== 404 && e.errcode !== 'M_NOT_FOUND') throw e;
    }
    switch (raw) {
      case 'invited': return HistoryVisibility.Invited;
      case 'joined': return HistoryVisibility.Joined;
      case 'world_readable': return HistoryVisibility.WorldReadable;
      case 'shared':
      default:
        return HistoryVisibility.Shared;
    }
  }

  async _isRoomEncrypted(roomId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
      );
      return !!data.algorithm;
    } catch (e) {
      // Only a 404 (M_NOT_FOUND) means "no encryption state event" → not encrypted.
      // Anything else (auth, rate limit, network, 5xx) is unsafe to interpret as
      // "plaintext is OK", because we'd risk leaking plaintext into an encrypted room.
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return false;
      throw e;
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
   * Returns ALL messages in the room by default — paginates backwards until
   * the room's history is exhausted. An internal safety cap (~5000 events)
   * exists to prevent runaway memory use on extremely large rooms; it is not
   * configurable by callers. When `sinceMinsAgo` is set, pagination stops
   * once messages older than the cutoff are reached. When `limit` is set,
   * pagination stops once that many text messages have been collected and
   * the newest `limit` are returned.
   *
   * @param {string} roomId
   * @param {object} [opts]
   * @param {number} [opts.limit] - Optional max number of text messages to return (newest first cut)
   * @param {string} [opts.from] - Matrix pagination token to resume from
   * @param {number} [opts.sinceMinsAgo] - Only return messages from the last N minutes
   */
  async readMessages(roomId, opts = {}) {
    const SAFETY_CAP_EVENTS = 5000;
    const PAGE_SIZE = 100;
    const userLimit = opts.limit && opts.limit > 0 ? opts.limit : null;
    const cutoffMs = this._computeCutoffMs(opts);
    const encrypted = await this._isRoomEncrypted(roomId);

    if (encrypted) {
      // Sync to get any pending room keys (_syncOnce already drains
      // outgoing requests internally).
      await this._syncOnce();
    }

    const allRawNewestFirst = [];
    let from = opts.from;
    let end = null;
    let textCount = 0;

    while (allRawNewestFirst.length < SAFETY_CAP_EVENTS) {
      let reqPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${PAGE_SIZE}`;
      if (from) reqPath += `&from=${encodeURIComponent(from)}`;

      const data = await this._fetch(reqPath);
      const chunk = data.chunk || [];
      end = data.end || end;

      if (chunk.length === 0) break;
      allRawNewestFirst.push(...chunk);

      // Track text-bearing events so userLimit can short-circuit. We can't
      // know exactly how many of these are renderable until decryption, but
      // this is a fine upper bound for "stop fetching more pages".
      for (const e of chunk) {
        if (e.type === 'm.room.message' || e.type === 'm.room.encrypted') textCount++;
      }

      if (!data.end) break;
      if (cutoffMs !== null) {
        const oldest = chunk[chunk.length - 1];
        if (oldest && oldest.origin_server_ts < cutoffMs) break;
      }
      if (userLimit !== null && textCount >= userLimit) break;
      from = data.end;
    }

    const events = allRawNewestFirst.reverse();

    const result = [];

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
      const acc = readAccountability(msgEvent.content);

      const entry = {
        event_id: msgEvent.event_id,
        sender,
        body,
        timestamp: event.origin_server_ts,
        accountability: acc
          ? {
              signed: true,
              prev_conv: acc.prev_conv ?? null,
              with_reply: acc.with_reply ?? null,
              reply_only: acc.reply_only ?? null,
            }
          : { signed: false },
      };

      result.push(entry);
    }

    return { messages: result, end };
  }

  /**
   * Read messages from every room the user has joined.
   *
   * Accepts the same options as `readMessages` (limit, sinceMinsAgo, maxPages,
   * from). Returns a map of roomId -> per-room result. Failures on a single
   * room are captured per-room and do not abort the others.
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

    if (encrypted) {
      // Pull any pending to-device events / device-list changes so that
      // _ensureRoomKeysShared sees the current member device set. Without
      // this, peers who joined or rotated devices since the last sync
      // would silently miss the room key for this message.
      await this._syncOnce();
    }

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
      [ACCOUNTABILITY_FIELD]: {
        prev_conv: signed.prev_conv_sign,
        with_reply: signed.with_reply_sign,
        reply_only: signed.reply_only_sign,
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
   *
   * Sequence (per matrix-sdk-crypto lifecycle):
   *   1. updateTrackedUsers — tell the machine we care about these users
   *   2. KeysQuery (via _processOutgoing) — fetch their device lists
   *   3. getMissingSessions — claim OTKs for any user/device we don't yet
   *      have an Olm session with, then run the resulting KeysClaim
   *   4. shareRoomKey — produce to-device messages with the Megolm key
   *   5. send those to-device messages
   *
   * Without step 3, devices that joined since the last sync silently miss
   * the room key and can't decrypt the message.
   */
  async _ensureRoomKeysShared(roomId) {
    const members = await this._getRoomMembers(roomId);
    const memberIds = members.map(m => new UserId(m));

    await this.olmMachine.updateTrackedUsers(memberIds);
    await this._processOutgoing(); // KeysQuery for member devices

    // Claim one-time keys for any (user, device) we don't yet have an Olm
    // session with. shareRoomKey would otherwise fail to deliver the room
    // key to those devices.
    const claimRequest = await this.olmMachine.getMissingSessions(memberIds);
    if (claimRequest) {
      await this._handleOutgoingRequest(claimRequest);
    }

    const settings = new EncryptionSettings();
    settings.historyVisibility = await this._getRoomHistoryVisibility(roomId);

    const toDeviceRequests = await this.olmMachine.shareRoomKey(
      new RoomId(roomId),
      memberIds,
      settings,
    );

    for (const req of toDeviceRequests) {
      await this._handleOutgoingRequest(req);
    }

    // Process any additional outgoing requests queued after sharing.
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

  /**
   * List rooms the current user has been invited to but has not yet joined.
   *
   * Uses a one-shot, zero-timeline `/sync` to fetch the `rooms.invite` map,
   * then extracts a friendly name/topic/inviter from the invite_state events
   * when available.
   *
   * @returns {Promise<Array<{roomId: string, name: string|null, topic: string|null, inviter: string|null}>>}
   */
  async listInvites() {
    const filter = JSON.stringify({
      room: {
        timeline: { limit: 0 },
        ephemeral: { limit: 0 },
        state: { limit: 0 },
        account_data: { limit: 0 },
      },
      presence: { limit: 0 },
    });
    const params = new URLSearchParams({ timeout: '0', filter });
    const sync = await this._fetch(`/_matrix/client/v3/sync?${params}`);
    const invitesObj = sync.rooms?.invite || {};
    const invites = [];
    for (const [roomId, room] of Object.entries(invitesObj)) {
      const events = room.invite_state?.events || [];
      let name = null;
      let topic = null;
      let inviter = null;
      for (const ev of events) {
        if (ev.type === 'm.room.name' && ev.content?.name) name = ev.content.name;
        else if (ev.type === 'm.room.topic' && ev.content?.topic) topic = ev.content.topic;
        else if (
          ev.type === 'm.room.member' &&
          ev.state_key === this.userId &&
          ev.content?.membership === 'invite'
        ) {
          inviter = ev.sender || null;
        }
      }
      invites.push({ roomId, name, topic, inviter });
    }
    return invites;
  }

  /**
   * Join a room (also used to accept a pending invite — the Matrix endpoint
   * is the same in both cases).
   */
  async joinRoom(roomId) {
    return this._fetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      body: '{}',
    });
  }

  /**
   * Reject a pending room invite. In Matrix, declining an invite is just
   * `leave` on the invited room.
   */
  async rejectInvite(roomId) {
    return this._leaveRoomRaw(roomId);
  }

  /**
   * Create a new Matrix room.
   *
   * @param {object} [opts]
   * @param {string} [opts.name] - Room display name
   * @param {string} [opts.topic] - Room topic
   * @param {string[]} [opts.invite] - User IDs to invite
   * @param {boolean} [opts.encrypted=true] - Enable E2E encryption (m.room.encryption)
   * @param {'public'|'private'} [opts.visibility='private'] - Directory visibility
   * @param {'public_chat'|'private_chat'|'trusted_private_chat'} [opts.preset]
   *   - Defaults to `private_chat` for `private` and `public_chat` for `public`
   * @returns {Promise<{room_id: string}>}
   */
  async createRoom(opts = {}) {
    const visibility = opts.visibility || 'private';
    const preset = opts.preset || (visibility === 'public' ? 'public_chat' : 'private_chat');
    const encrypted = opts.encrypted !== false;

    const body = {
      visibility,
      preset,
    };
    if (opts.name) body.name = opts.name;
    if (opts.topic) body.topic = opts.topic;
    if (Array.isArray(opts.invite) && opts.invite.length) body.invite = opts.invite;
    if (encrypted) {
      body.initial_state = [
        {
          type: 'm.room.encryption',
          state_key: '',
          content: { algorithm: 'm.megolm.v1.aes-sha2' },
        },
      ];
    }

    return this._fetch('/_matrix/client/v3/createRoom', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Leave a room and forget it. Matrix has no "delete room" operation for
   * regular users — leaving + forgetting removes the room from your own
   * view, which is the closest user-facing equivalent. Other members keep
   * their copies until they leave too.
   */
  async leaveRoom(roomId) {
    await this._leaveRoomRaw(roomId);
    try {
      await this._fetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/forget`, {
        method: 'POST',
        body: '{}',
      });
    } catch (e) {
      // Forget can fail if the server already cleaned up — non-fatal.
      if (e.status !== 404 && e.errcode !== 'M_NOT_FOUND') throw e;
    }
    return { room_id: roomId, left: true };
  }

  async _leaveRoomRaw(roomId) {
    return this._fetch(`/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/leave`, {
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
