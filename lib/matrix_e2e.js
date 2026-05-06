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
const { MemoryStore } = require('./memory');
const { marked } = require('marked');
const {
  generateEd25519Keypair,
  loadEd25519Keypair,
  buildSignedCrossSigningKey,
  signDeviceKeys,
} = require('./cross_signing');

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.subnet-client-state');

// Field name used when sending. The SDK does not inspect this field on
// read — callers can do their own verification if they need to.
const ACCOUNTABILITY_FIELD = 'xyz.vanadium.accountability';

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
    this.memoryStore = null;
  }

  /**
   * Lazily open the agent memory store (memory.sqlite3 in storePath).
   * Returns the same instance on subsequent calls.
   */
  _getMemoryStore() {
    if (!this.memoryStore) {
      this.memoryStore = new MemoryStore(this.storePath);
    }
    return this.memoryStore;
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

  // ── Sync token persistence ───────────────────────────────────────────────────
  // Synapse uses the next_batch token from a previous /sync to know which
  // to_device events the device has already received. Without persisting it,
  // every CLI invocation does a fresh /sync from scratch and can miss room
  // keys delivered between invocations.

  _syncTokenFile() {
    return path.join(this.storePath, 'sync_token');
  }

  _loadSyncToken() {
    try {
      const f = this._syncTokenFile();
      if (fs.existsSync(f)) {
        const t = fs.readFileSync(f, 'utf8').trim();
        return t || null;
      }
    } catch {}
    return null;
  }

  _saveSyncToken(token) {
    if (!token) return;
    try {
      fs.mkdirSync(this.storePath, { recursive: true });
      fs.writeFileSync(this._syncTokenFile(), token);
    } catch {}
  }

  // ── HTTP helpers ─────────────────────────────────────────────────────────────

  /**
   * Raw fetch — returns the Response object without parsing JSON.
   * Used for binary uploads/downloads where the body is not JSON.
   */
  async _fetchRaw(urlPath, opts = {}) {
    const url = `${this.matrixUrl}${urlPath}`;
    const headers = { ...opts.headers };
    if (this.accessToken) headers['Authorization'] = `Bearer ${this.accessToken}`;
    const res = await fetch(url, { ...opts, headers });
    if (res.status === 429) {
      const headerSecs = Number(res.headers.get('retry-after'));
      const headerMs = Number.isFinite(headerSecs) ? headerSecs * 1000 : 0;
      const waitMs = Math.min(Math.max(headerMs, 1000) + 500, 60_000);
      await new Promise(r => setTimeout(r, waitMs));
      return this._fetchRaw(urlPath, opts);
    }
    if (!res.ok) {
      let data = {};
      try { data = await res.json(); } catch {}
      const err = new Error(data.error || `Matrix API error ${res.status} on ${urlPath}`);
      err.status = res.status;
      err.errcode = data.errcode;
      throw err;
    }
    return res;
  }

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

    // Ensure the bot has a cross-signing identity on the server and that
    // this device is signed by it. Without this, Element shows an
    // "unverified device" warning shield next to every message we send.
    // Best-effort: a failure here doesn't break message send/receive,
    // it only leaves the warning shield in place. We swallow the error
    // so a homeserver that requires SSO UIA (or a transient network
    // blip) can't take down the whole client.
    try {
      await this._ensureCrossSigning(password);
    } catch (e) {
      console.warn('[E2E] cross-signing setup skipped:', e.message);
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
        const eventType = encodeURIComponent(req.eventType);
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

  // ── Cross-signing ────────────────────────────────────────────────────────────
  //
  // The matrix-sdk-crypto-nodejs napi binding's `bootstrapCrossSigning`
  // is incomplete: it generates the master/self-signing/user-signing
  // keypairs locally but never queues an upload request via
  // `outgoingRequests`, so the keys never reach the server. Without
  // those keys uploaded, Element shows an "unverified device" warning
  // shield next to every message the bot sends.
  //
  // We work around this by generating the cross-signing keypairs
  // ourselves with Node's crypto module and uploading them through the
  // standard Matrix REST endpoints. Private keys live in
  // `<storePath>/cross_signing.json` so subsequent runs of the same bot
  // reuse the same identity.

  _crossSigningFile() {
    return path.join(this.storePath, 'cross_signing.json');
  }

  _loadCrossSigningKeys() {
    try {
      if (fs.existsSync(this._crossSigningFile())) {
        return JSON.parse(fs.readFileSync(this._crossSigningFile(), 'utf8'));
      }
    } catch {}
    return null;
  }

  _saveCrossSigningKeys(stored) {
    fs.mkdirSync(this.storePath, { recursive: true });
    fs.writeFileSync(
      this._crossSigningFile(),
      JSON.stringify(stored, null, 2),
      { mode: 0o600 },
    );
  }

  /**
   * POST `body` to `urlPath`, transparently completing the
   * `m.login.password` user-interactive-auth challenge if the server
   * demands one. The bot has its Matrix password from login(), so it
   * can satisfy the password stage on its own.
   *
   * Throws if the server requires a flow we can't satisfy with a
   * password (e.g. an SSO-only deployment) — at which point cross
   * signing has to be set up out of band by the human operator.
   */
  async _fetchWithUIA(urlPath, body, password) {
    let res;
    try {
      return await this._fetch(urlPath, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    } catch (e) {
      if (e.status !== 401) throw e;
      // _fetch throws on non-2xx but doesn't expose the response body.
      // Re-issue the request directly so we can see the UIA challenge.
      res = await fetch(`${this.matrixUrl}${urlPath}`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.accessToken}`,
        },
        body: JSON.stringify(body),
      });
    }
    const challenge = await res.json();
    if (!challenge.session) {
      throw new Error(`UIA challenge had no session token: ${JSON.stringify(challenge)}`);
    }
    const flows = challenge.flows || [];
    const passwordFlow = flows.find(f =>
      Array.isArray(f.stages) && f.stages.length === 1 && f.stages[0] === 'm.login.password',
    );
    if (!passwordFlow) {
      throw new Error(
        `Server requires a UIA flow we can't satisfy with a password. ` +
        `Available flows: ${JSON.stringify(flows)}. Set up cross-signing ` +
        `out-of-band (e.g. via Element) and copy cross_signing.json into the ` +
        `state directory.`,
      );
    }
    const authedBody = {
      ...body,
      auth: {
        type: 'm.login.password',
        session: challenge.session,
        identifier: { type: 'm.id.user', user: this.userId },
        password,
      },
    };
    return this._fetch(urlPath, {
      method: 'POST',
      body: JSON.stringify(authedBody),
    });
  }

  /**
   * Ensure the bot has a server-side cross-signing identity AND that
   * its current device is signed by that identity's self-signing key.
   *
   * The flow has to be careful not to clobber an existing identity. If
   * the user previously set up cross-signing through Element (with a
   * recovery key), uploading new master/self/user keys here would break
   * their entire trust web. So we always check the server first.
   *
   *   server_has_master ? local_keys ?    action
   *   ─────────────────────────────────────────────────────────────────
   *   no                  no              generate, upload, sign device
   *   no                  yes             upload local keys, sign device
   *                                       (server lost them, recover)
   *   yes (matches local) yes             sign device only
   *   yes (mismatch)      yes/no          do nothing, warn — manual
   *                                       intervention needed
   *
   * The `sign device` step itself is idempotent on the server but we
   * skip it if the device already carries an SSK signature, to avoid an
   * unnecessary round-trip on every cold start.
   */
  async _ensureCrossSigning(password) {
    // Step 1: ask the server what it knows about our user.
    const queryRes = await this._fetch('/_matrix/client/v3/keys/query', {
      method: 'POST',
      body: JSON.stringify({ device_keys: { [this.userId]: [] } }),
    });
    const serverMasterKey = queryRes?.master_keys?.[this.userId] || null;
    const serverMasterEd25519 = serverMasterKey
      ? Object.values(serverMasterKey.keys || {})[0] || null
      : null;

    let stored = this._loadCrossSigningKeys();
    let master, selfSigning, userSigning;

    if (stored) {
      // Local cross-signing keys exist. Make sure they line up with
      // whatever the server has before we trust them.
      if (serverMasterEd25519 && serverMasterEd25519 !== stored.master.public) {
        console.warn(
          '[E2E] cross-signing skipped: server has a different master key than ' +
          `cross_signing.json. Local master ${stored.master.public} vs. server ` +
          `${serverMasterEd25519}. Verify this device manually in Element, or ` +
          `delete cross_signing.json after copying the right master key in.`,
        );
        return;
      }
      master = loadEd25519Keypair(stored.master);
      selfSigning = loadEd25519Keypair(stored.self_signing);
      userSigning = loadEd25519Keypair(stored.user_signing);

      // Server doesn't have our keys yet (e.g. fresh server, restored
      // from a backup that lost cross-signing) — re-upload from local.
      if (!serverMasterEd25519) {
        await this._uploadCrossSigningTriple(master, selfSigning, userSigning, password);
      }
    } else {
      // Either the server has no identity at all (greenfield), or it has
      // one from a previous Element session but we don't have the private
      // keys. In both cases, mint fresh keys and upload. For a bot
      // account the old trust web is meaningless — resetting is safe.
      if (serverMasterEd25519) {
        console.warn(
          '[E2E] cross-signing: replacing existing server identity ' +
          `(${serverMasterEd25519}) with a fresh one.`,
        );
      }
      master = generateEd25519Keypair();
      selfSigning = generateEd25519Keypair();
      userSigning = generateEd25519Keypair();
      await this._uploadCrossSigningTriple(master, selfSigning, userSigning, password);
      stored = {
        master: { public: master.publicBase64, private: master.privateBase64 },
        self_signing: { public: selfSigning.publicBase64, private: selfSigning.privateBase64 },
        user_signing: { public: userSigning.publicBase64, private: userSigning.privateBase64 },
      };
      this._saveCrossSigningKeys(stored);
    }

    // Step 2: sign THIS device with the self-signing key (skip if the
    // server already has the signature). Re-use queryRes when possible
    // — its device_keys map already contains what we need on a warm
    // start.
    let deviceKeys = queryRes?.device_keys?.[this.userId]?.[this.deviceId];
    if (!deviceKeys) {
      // We didn't ask for the device explicitly the first time round.
      // Re-query for just our device.
      const second = await this._fetch('/_matrix/client/v3/keys/query', {
        method: 'POST',
        body: JSON.stringify({ device_keys: { [this.userId]: [this.deviceId] } }),
      });
      deviceKeys = second?.device_keys?.[this.userId]?.[this.deviceId];
    }
    if (!deviceKeys) return;

    const sskKeyId = `ed25519:${selfSigning.publicBase64}`;
    if (deviceKeys.signatures?.[this.userId]?.[sskKeyId]) return;

    const signedDeviceKeys = signDeviceKeys({
      deviceKeys,
      sskPublicBase64: selfSigning.publicBase64,
      sskPrivateKey: selfSigning.privateKey,
    });
    await this._fetch('/_matrix/client/v3/keys/signatures/upload', {
      method: 'POST',
      body: JSON.stringify({
        [this.userId]: { [this.deviceId]: signedDeviceKeys },
      }),
    });
  }

  /**
   * Build & upload the three CrossSigningKey JSON objects to
   * `/_matrix/client/v3/keys/device_signing/upload`. Completes the
   * m.login.password UIA challenge inline.
   */
  async _uploadCrossSigningTriple(master, selfSigning, userSigning, password) {
    const masterKeyId = `ed25519:${master.publicBase64}`;
    const masterKey = buildSignedCrossSigningKey({
      userId: this.userId,
      usage: ['master'],
      publicBase64: master.publicBase64,
      signers: [{ keyId: masterKeyId, privateKey: master.privateKey }],
    });
    const selfSigningKey = buildSignedCrossSigningKey({
      userId: this.userId,
      usage: ['self_signing'],
      publicBase64: selfSigning.publicBase64,
      signers: [{ keyId: masterKeyId, privateKey: master.privateKey }],
    });
    const userSigningKey = buildSignedCrossSigningKey({
      userId: this.userId,
      usage: ['user_signing'],
      publicBase64: userSigning.publicBase64,
      signers: [{ keyId: masterKeyId, privateKey: master.privateKey }],
    });
    await this._fetchWithUIA(
      '/_matrix/client/v3/keys/device_signing/upload',
      {
        master_key: masterKey,
        self_signing_key: selfSigningKey,
        user_signing_key: userSigningKey,
      },
      password,
    );
  }

  /**
   * Do a one-shot /sync to retrieve to-device events and process key exchanges.
   * This is needed before reading from or sending to encrypted rooms.
   *
   * Resumes from the persisted next_batch token if one exists, and writes
   * the new next_batch back on success. This is what tells Synapse "I
   * received those to_device events" — without it, room keys delivered
   * between CLI invocations can be silently dropped.
   *
   * The /sync filter intentionally lets state events through so the
   * OlmMachine sees m.room.encryption (rotation params) and m.room.member
   * changes (new joins). Those are what keep outbound megolm sessions
   * addressed to the right device set.
   */
  async _syncOnce(since) {
    const sinceToken = since ?? this._loadSyncToken();
    const params = new URLSearchParams({ timeout: '0', filter: JSON.stringify({
      room: { timeline: { limit: 0 }, ephemeral: { limit: 0 } },
      presence: { limit: 0 },
    }) });
    if (sinceToken) params.set('since', sinceToken);

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

    if (sync.next_batch) this._saveSyncToken(sync.next_batch);
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
   * One-shot fetch of every currently-joined member's display name for a
   * room. Returns a Map<userId, displayName> — display name is `null` when
   * the member hasn't set one. Users who left the room will not appear.
   */
  async _getRoomDisplayNames(roomId) {
    const data = await this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
    );
    const out = new Map();
    for (const [userId, info] of Object.entries(data.joined || {})) {
      out.set(userId, info?.display_name || null);
    }
    return out;
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
   * Compute a unix-ms cutoff from `sinceMinsAgo` (minutes ago) or
   * `sinceCutoffMs` (absolute unix-ms). Returns null when neither is set.
   * `sinceCutoffMs` takes precedence — use it when you need millisecond
   * precision (e.g. resuming from a stored checkpoint).
   */
  _computeCutoffMs(opts) {
    if (opts.sinceCutoffMs !== undefined && opts.sinceCutoffMs !== null) {
      return Number(opts.sinceCutoffMs);
    }
    if (opts.sinceMinsAgo !== undefined && opts.sinceMinsAgo !== null) {
      return Date.now() - Number(opts.sinceMinsAgo) * 60_000;
    }
    return null;
  }

  /**
   * Send an m.room_key_request to-device event asking peers (and our own
   * other devices) to re-share the megolm session that decryption just
   * failed for. The reply arrives as an m.forwarded_room_key in a future
   * /sync's to_device events, which `receiveSyncChanges` handles
   * automatically — so the next decryptRoomEvent on this session can
   * succeed.
   *
   * NOTE: matrix-sdk-crypto-nodejs v0.4.0 does not expose
   * `olmMachine.requestRoomKey`, so this builds the to-device event by
   * hand. Per-invocation dedupe avoids spamming peers when many events
   * share the same megolm session.
   */
  async _requestRoomKey(event, roomId) {
    const senderKey = event?.content?.sender_key;
    const sessionId = event?.content?.session_id;
    if (!senderKey || !sessionId || !event?.sender) return;

    if (!this._roomKeyRequestsSent) this._roomKeyRequestsSent = new Set();
    const dedupKey = `${roomId}|${sessionId}|${senderKey}`;
    if (this._roomKeyRequestsSent.has(dedupKey)) return;
    this._roomKeyRequestsSent.add(dedupKey);

    const requestId = `mrkr_${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const txnId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const requestBody = {
      action: 'request',
      body: {
        algorithm: 'm.megolm.v1.aes-sha2',
        room_id: roomId,
        sender_key: senderKey,
        session_id: sessionId,
      },
      request_id: requestId,
      requesting_device_id: this.deviceId,
    };
    // Address the original sender's devices AND our own other devices —
    // either may be holding the session and able to forward it.
    const messages = {
      [event.sender]: { '*': requestBody },
    };
    if (event.sender !== this.userId) {
      messages[this.userId] = { '*': requestBody };
    }
    try {
      await this._fetch(
        `/_matrix/client/v3/sendToDevice/m.room_key_request/${txnId}`,
        { method: 'PUT', body: JSON.stringify({ messages }) },
      );
    } catch {
      // Best-effort: never let a failed key request break the read.
    }
  }

  /**
   * Decrypt + project a single raw timeline event into the SDK's message
   * shape. Returns a message object on success, or null if the event isn't
   * a text message at all (and so should be silently dropped). For
   * encrypted events that fail to decrypt, returns a placeholder message
   * with body `[unable to decrypt]` so the caller still sees something.
   */
  async _projectEvent(event, encrypted, displayNames, roomId) {
    let msgEvent = event;
    if (event.type === 'm.room.encrypted' && encrypted) {
      try {
        const decryptedJson = await this.olmMachine.decryptRoomEvent(
          JSON.stringify(event),
          new RoomId(roomId),
        );
        const decrypted = JSON.parse(decryptedJson.event);
        msgEvent = { ...event, type: decrypted.type, content: decrypted.content };
      } catch (e) {
        // Fire (don't await) an m.room_key_request so peers can re-share
        // this megolm session. The forwarded key will arrive on a future
        // /sync and the next read of the same event will decrypt cleanly.
        this._requestRoomKey(event, roomId).catch(() => {});
        return {
          event_id: event.event_id,
          sender: event.sender,
          display_name: displayNames.get(event.sender) || null,
          body: '[unable to decrypt]',
          timestamp: event.origin_server_ts,
        };
      }
    }
    if (msgEvent.type !== 'm.room.message') return null;

    const msgtype = msgEvent.content?.msgtype;
    if (msgtype === 'm.text') {
      const result = {
        event_id: msgEvent.event_id,
        sender: msgEvent.sender,
        display_name: displayNames.get(msgEvent.sender) || null,
        body: msgEvent.content.body,
        timestamp: event.origin_server_ts,
      };
      const rel = msgEvent.content['m.relates_to'];
      if (rel) {
        if (rel.rel_type === 'm.thread') {
          result.thread_id = rel.event_id;
          if (rel['m.in_reply_to']?.event_id) result.reply_to = rel['m.in_reply_to'].event_id;
        } else if (rel['m.in_reply_to']?.event_id) {
          result.reply_to = rel['m.in_reply_to'].event_id;
        }
      }
      return result;
    }

    // File-like messages: expose attachment info so callers can download them
    const FILE_TYPES = ['m.file', 'm.image', 'm.video', 'm.audio'];
    if (FILE_TYPES.includes(msgtype)) {
      const c = msgEvent.content;
      // Unencrypted: url is in c.url. E2E-encrypted: url is in c.file.url (needs decryption).
      const mxcUrl = c.url || c.file?.url || null;
      const filename = c.filename || c.body || 'file';
      const mimetype = c.info?.mimetype || c.file?.mimetype || null;
      const isEncrypted = !c.url && !!c.file;
      const attachment = { msgtype, mxc_url: mxcUrl, filename, mimetype, encrypted: isEncrypted };
      // Pass through the EncryptedFile object (key, iv, hashes) so callers can decrypt
      if (isEncrypted && c.file) attachment.encrypt_info = c.file;
      return {
        event_id: msgEvent.event_id,
        sender: msgEvent.sender,
        display_name: displayNames.get(msgEvent.sender) || null,
        body: `[${msgtype.replace('m.', '')}: ${filename}]`,
        timestamp: event.origin_server_ts,
        attachment,
      };
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
   * When `oldContextCount` is set together with `sinceMinsAgo`, pagination
   * keeps going past the cutoff until it has collected that many
   * text-bearing events older than the cutoff. The return shape gains an
   * `old_context` array containing the (up to `oldContextCount`) most
   * recent messages from before the cutoff. Use this to give callers a
   * little prior context without an extra round-trip.
   *
   * @param {string} roomId
   * @param {object} [opts]
   * @param {number} [opts.limit] - Optional max number of text messages to return (newest first cut)
   * @param {string} [opts.from] - Matrix pagination token to resume from
   * @param {number} [opts.sinceMinsAgo] - Only return messages from the last N minutes
   * @param {number} [opts.sinceCutoffMs] - Absolute unix-ms cutoff. Takes
   *   precedence over `sinceMinsAgo`. Use when you need ms-precision (e.g.
   *   resuming from a checkpoint).
   * @param {number} [opts.oldContextCount] - When set together with a
   *   cutoff (`sinceMinsAgo` / `sinceCutoffMs`), also return up to N
   *   messages older than the cutoff under `old_context`. Pagination
   *   stops as soon as this many are collected.
   */
  async readMessages(roomId, opts = {}) {
    const SAFETY_CAP_EVENTS = 5000;
    const PAGE_SIZE = 100;
    const userLimit = opts.limit && opts.limit > 0 ? opts.limit : null;
    const cutoffMs = this._computeCutoffMs(opts);
    const oldContextCount =
      opts.oldContextCount && opts.oldContextCount > 0 ? opts.oldContextCount : 0;
    const wantOldContext = oldContextCount > 0 && cutoffMs !== null;
    const encrypted = await this._isRoomEncrypted(roomId);

    if (encrypted) {
      // Sync to get any pending room keys (_syncOnce already drains
      // outgoing requests internally).
      await this._syncOnce();
    }

    // One-shot: every currently-joined member's display name. Used to
    // attach a `display_name` field to each message below.
    let displayNames;
    try {
      displayNames = await this._getRoomDisplayNames(roomId);
    } catch {
      displayNames = new Map();
    }

    const allRawNewestFirst = [];
    let from = opts.from;
    let end = null;
    let textCount = 0;
    let oldTextCount = 0;

    while (allRawNewestFirst.length < SAFETY_CAP_EVENTS) {
      let reqPath = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${PAGE_SIZE}`;
      if (from) reqPath += `&from=${encodeURIComponent(from)}`;

      const data = await this._fetch(reqPath);
      const chunk = data.chunk || [];
      end = data.end || end;

      if (chunk.length === 0) break;
      allRawNewestFirst.push(...chunk);

      // Track text-bearing events so userLimit / oldContextCount can
      // short-circuit. We can't know exactly how many of these will
      // actually decrypt to text, but it's a fine upper bound for "stop
      // fetching more pages".
      for (const e of chunk) {
        if (e.type === 'm.room.message' || e.type === 'm.room.encrypted') {
          textCount++;
          if (cutoffMs !== null && e.origin_server_ts < cutoffMs) oldTextCount++;
        }
      }

      if (!data.end) break;
      if (cutoffMs !== null) {
        if (wantOldContext) {
          // Keep going until we've seen enough older events to fill
          // old_context. Once we have, the caller has everything they
          // asked for and we can stop.
          if (oldTextCount >= oldContextCount) break;
        } else {
          const oldest = chunk[chunk.length - 1];
          if (oldest && oldest.origin_server_ts < cutoffMs) break;
        }
      }
      if (userLimit !== null && textCount >= userLimit) break;
      from = data.end;
    }

    const events = allRawNewestFirst.reverse();

    const newMessages = [];
    const olderMessages = [];

    for (const event of events) {
      const isOlder = cutoffMs !== null && event.origin_server_ts < cutoffMs;
      if (isOlder && !wantOldContext) continue;

      const msg = await this._projectEvent(event, encrypted, displayNames, roomId);
      if (msg === null) continue;

      if (isOlder) olderMessages.push(msg);
      else newMessages.push(msg);
    }

    if (wantOldContext) {
      // olderMessages is oldest-first; tail is the most recent ones,
      // which are the most useful as immediate context.
      return {
        messages: newMessages,
        old_context: olderMessages.slice(-oldContextCount),
        end,
      };
    }
    return { messages: newMessages, end };
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

  /**
   * Fetch the room's `m.room.name` state event. Returns null if unset.
   */
  async _getRoomName(roomId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.name`,
      );
      return data.name || null;
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Fetch the room's `m.room.topic` state event. Returns null if unset.
   */
  async _getRoomTopic(roomId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.topic`,
      );
      return data.topic || null;
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Returns the `type` field of `m.room.create`. For a Matrix Space this is
   * the literal string "m.space"; for a regular room it is undefined/null.
   * Used to distinguish spaces from rooms when listing.
   */
  async _getRoomCreateType(roomId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.create`,
      );
      return data.type || null;
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Fetch the room's `m.room.avatar` state event. Returns the mxc:// URI
   * stored in `content.url`, or null if no avatar is set. Use the returned
   * mxc URI with `downloadMedia()` (or expose it directly to UI clients).
   */
  async _getRoomAvatar(roomId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.avatar`,
      );
      return data.url || null;
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return null;
      throw e;
    }
  }

  /**
   * Read all `m.space.parent` state events for the given room and return the
   * parent space room IDs (the state_keys). A room can declare multiple
   * parent spaces; spaces themselves can also be nested.
   */
  async _getRoomParentSpaces(roomId) {
    try {
      const events = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state`,
      );
      const out = [];
      for (const ev of events || []) {
        if (ev.type === 'm.space.parent' && ev.state_key && ev.content && Object.keys(ev.content).length > 0) {
          out.push(ev.state_key);
        }
      }
      return out;
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return [];
      // /state requires membership; if we don't have it, give up gracefully.
      if (e.status === 403) return [];
      throw e;
    }
  }

  /**
   * Checkpoint-aware variant of `readAllMessages`.
   *
   * For every joined room, splits the room's recent text messages into:
   *   - `new_messages`: messages strictly newer than the persisted
   *                     checkpoint (or, on first read, newer than 2 days
   *                     ago)
   *   - `old_context`:  the 10 most recent text messages from before the
   *                     checkpoint, so the agent always has a little
   *                     prior context to anchor the new ones. Always 10,
   *                     not configurable.
   *
   * On first read for a room (no checkpoint yet), the cutoff defaults to
   * `defaultLookbackDays` (2) days ago. After a successful read the
   * checkpoint is advanced to the timestamp of the newest message returned,
   * so subsequent calls only surface genuinely new traffic. Pagination
   * uses the `oldContextCount` mode of `readMessages`, so we stop walking
   * history as soon as we have 10 events older than the cutoff — bounded
   * cost regardless of how active the room is.
   *
   * Each room entry includes `room_id` (verbatim Matrix room ID, suitable
   * for `sendMessage`) plus `name`/`topic` so the agent can recognise which
   * room it's looking at when deciding where to reply.
   *
   * The top-level return object contains two keys:
   *   - `rooms`:           map of roomId -> per-room result (unchanged)
   *   - `pending_invites`: array of pending room invites, each with
   *                        { roomId, name, topic, inviter }. Empty array
   *                        if there are no pending invites.
   *
   * @param {object} [opts]
   * @param {number} [opts.defaultLookbackDays=2] - Lookback window when no
   *   checkpoint exists yet for a room.
   * @param {boolean} [opts.markAsRead=true] - Whether to persist the new
   *   checkpoint after reading (i.e. mark the surfaced messages as read).
   *   Set to false for a peek — messages will be re-surfaced on the next
   *   call. Also accepted as `mark_as_read` or the original
   *   `advanceCheckpoint`.
   */
  async readAllNewMessages(opts = {}) {
    const OLD_CONTEXT_COUNT = 10;
    const defaultLookbackDays = opts.defaultLookbackDays ?? 2;
    // `markAsRead` (with snake_case alias) is the user-facing name for this
    // option; `advanceCheckpoint` is the original spelling and remains supported.
    const markAsRead =
      opts.markAsRead ?? opts.mark_as_read ?? opts.advanceCheckpoint;
    const advanceCheckpoint = markAsRead !== false;
    const defaultLookbackMs = defaultLookbackDays * 24 * 60 * 60 * 1000;

    const memory = this._getMemoryStore();
    const roomIds = await this.listJoinedRooms();
    const rooms = {};

    for (const roomId of roomIds) {
      try {
        const checkpoint = memory.getCheckpoint(roomId);
        const cutoffMs =
          checkpoint !== null ? checkpoint : Date.now() - defaultLookbackMs;

        // The checkpoint is the ts of the newest message we've already
        // delivered. We want messages STRICTLY newer than that, so we use
        // `cutoff + 1` as the readMessages cutoff. readMessages treats
        // events with ts < cutoff as "older", so a message at exactly
        // `checkpoint` correctly falls into old_context and is never
        // re-delivered as new.
        const { messages: newMessages, old_context: oldContext } =
          await this.readMessages(roomId, {
            sinceCutoffMs: cutoffMs + 1,
            oldContextCount: OLD_CONTEXT_COUNT,
          });

        if (advanceCheckpoint && newMessages.length > 0) {
          const newest = newMessages[newMessages.length - 1].timestamp;
          memory.setCheckpoint(roomId, newest);
        } else if (advanceCheckpoint && checkpoint === null) {
          // First read for a quiet room: stamp the checkpoint at the
          // cutoff so the next call doesn't re-walk the same 2-day window.
          memory.setCheckpoint(roomId, cutoffMs);
        }

        const [name, topic] = await Promise.all([
          this._getRoomName(roomId).catch(() => null),
          this._getRoomTopic(roomId).catch(() => null),
        ]);

        rooms[roomId] = {
          room_id: roomId,
          name,
          topic,
          checkpoint_ms: cutoffMs,
          new_messages: newMessages,
          old_context: oldContext,
        };
      } catch (e) {
        rooms[roomId] = {
          room_id: roomId,
          name: null,
          topic: null,
          new_messages: [],
          old_context: [],
          error: e.message,
        };
      }
    }

    let pending_invites = [];
    try {
      pending_invites = await this.listInvites();
    } catch (e) {
      // Non-fatal — invite fetch failure should not break message delivery
    }

    return { rooms, pending_invites };
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
    const htmlBody = marked.parse(text);
    const content = {
      msgtype: 'm.text',
      body: text,
      format: 'org.matrix.custom.html',
      formatted_body: htmlBody,
      [ACCOUNTABILITY_FIELD]: {
        prev_conv: signed.prev_conv_sign,
        with_reply: signed.with_reply_sign,
        reply_only: signed.reply_only_sign,
      },
    };

    // Thread and/or reply support (MSC3440 / m.thread)
    if (opts.threadRootId) {
      content['m.relates_to'] = {
        rel_type: 'm.thread',
        event_id: opts.threadRootId,
        is_falling_back: true,
        'm.in_reply_to': { event_id: opts.replyToEventId || opts.threadRootId },
      };
    } else if (opts.replyToEventId) {
      content['m.relates_to'] = {
        'm.in_reply_to': { event_id: opts.replyToEventId },
      };
    }

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
   * Send a reaction (m.reaction / m.annotation) to an existing event.
   *
   * Always sent cleartext — m.relates_to must be server-visible so peers and
   * servers can tally annotations. Works in both encrypted and unencrypted
   * rooms; Synapse does not enforce encryption on m.reaction events.
   *
   * @param {string} roomId  - target room
   * @param {string} eventId - event_id to react to
   * @param {string} key     - reaction key (typically a single emoji, e.g. "👎")
   * @returns {Promise<{event_id: string}>}
   */
  async sendReaction(roomId, eventId, key) {
    if (!roomId || !eventId || !key) {
      throw new Error('sendReaction requires roomId, eventId, and key');
    }
    const content = {
      'm.relates_to': {
        rel_type: 'm.annotation',
        event_id: eventId,
        key,
      },
    };
    const txnId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const result = await this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.reaction/${txnId}`,
      { method: 'PUT', body: JSON.stringify(content) },
    );
    return { event_id: result.event_id };
  }

  /**
   * Ensure room keys are shared with all current room members.
   *
   * Sequence (per matrix-sdk-crypto lifecycle):
   *   1. Synthetically mark every member as device-list-changed so the
   *      OlmMachine queues a KeysQuery for each on the next outgoing pass.
   *      This is necessary because `updateTrackedUsers` is a no-op for any
   *      user the OlmMachine has already auto-tracked from an inbound
   *      to_device event — that user ends up "tracked but not dirty," with
   *      zero devices in the local store, and `shareRoomKey` then silently
   *      produces zero to_device requests for them. Forcing them into
   *      `device_lists.changed` via `receiveSyncChanges` is the
   *      napi-binding-safe way to mark them dirty and trigger the query.
   *   2. updateTrackedUsers — register users we care about (idempotent).
   *   3. KeysQuery (via _processOutgoing) — fetch their device lists.
   *   4. getMissingSessions — claim OTKs for any user/device we don't yet
   *      have an Olm session with, then run the resulting KeysClaim.
   *   5. shareRoomKey — produce to-device messages with the Megolm key.
   *   6. send those to-device messages.
   */
  async _ensureRoomKeysShared(roomId) {
    const members = await this._getRoomMembers(roomId);
    const memberIds = members.map(m => new UserId(m));

    // Force every current room member to be re-queried. We hand the
    // OlmMachine a synthetic `device_lists.changed` containing each
    // member, which marks them dirty even if they were previously
    // auto-tracked from an inbound message and have no device records yet.
    const forcedDeviceLists = new DeviceLists(
      members.map(m => new UserId(m)),
      [],
    );
    await this.olmMachine.receiveSyncChanges(
      JSON.stringify([]),
      forcedDeviceLists,
      {},
      [],
    );

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
   * Like listJoinedRooms() but also includes a clear-text name and topic
   * for each room. Costs N+1 HTTP round-trips (one /joined_rooms plus one
   * state read per room) — the browser variant is much cheaper because it
   * uses matrix-js-sdk's local Room cache.
   *
   * @returns {Promise<Array<{room_id: string, name: string|null, topic: string|null}>>}
   */
  async listJoinedRoomsWithNames() {
    const ids = await this.listJoinedRooms();
    const out = [];
    for (const room_id of ids) {
      const [name, topic, createType, parentSpaces, avatarUrl] = await Promise.all([
        this._getRoomName(room_id).catch(() => null),
        this._getRoomTopic(room_id).catch(() => null),
        this._getRoomCreateType(room_id).catch(() => null),
        this._getRoomParentSpaces(room_id).catch(() => []),
        this._getRoomAvatar(room_id).catch(() => null),
      ]);
      out.push({
        room_id,
        name,
        topic,
        avatar_url: avatarUrl,
        is_space: createType === 'm.space',
        room_type: createType || null,
        parent_spaces: parentSpaces,
      });
    }
    return out;
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
      let createType = null;
      for (const ev of events) {
        if (ev.type === 'm.room.name' && ev.content?.name) name = ev.content.name;
        else if (ev.type === 'm.room.topic' && ev.content?.topic) topic = ev.content.topic;
        else if (ev.type === 'm.room.create' && ev.content?.type) createType = ev.content.type;
        else if (
          ev.type === 'm.room.member' &&
          ev.state_key === this.userId &&
          ev.content?.membership === 'invite'
        ) {
          inviter = ev.sender || null;
        }
      }
      invites.push({
        roomId,
        name,
        topic,
        inviter,
        is_space: createType === 'm.space',
        room_type: createType || null,
      });
    }
    return invites;
  }

  /**
   * Join a room (also used to accept a pending invite — the Matrix endpoint
   * is the same in both cases).
   *
   * After the /join POST we run one /sync and, if the room is encrypted, an
   * _ensureRoomKeysShared pass. This gives the OlmMachine a chance to:
   *   - drain to_device events peers may have queued for us (megolm keys),
   *   - mark peer devices as tracked so KeysQuery fetches their lists, and
   *   - establish outbound Olm sessions so subsequent sends don't race the
   *     first message through an empty key store.
   *
   * Without this, a fresh join left the device in a "zero inbound megolm
   * sessions" state and peers only re-shared the room key on their next
   * outbound message, which for low-traffic rooms meant new messages read
   * as "[unable to decrypt]" until a peer happened to rotate. The extra
   * work is wrapped in try/catch so transient sync/key failures never
   * block the join itself — callers can still recover by sending or
   * receiving a message, which re-runs the same plumbing.
   */
  async joinRoom(roomId) {
    const result = await this._fetch(
      `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`,
      { method: 'POST', body: '{}' },
    );
    try {
      await this._syncOnce();
      if (await this._isRoomEncrypted(roomId)) {
        await this._ensureRoomKeysShared(roomId);
      }
    } catch (_e) {
      // Non-fatal — /join succeeded. Key setup retries on next send/read.
    }
    return result;
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
   * Create a Matrix Space (a room with `creation_content.type = m.space`).
   *
   * Spaces are never E2E-encrypted (they only carry membership + child
   * pointers, not message content) — `opts.encrypted` is ignored.
   *
   * @param {object} [opts]
   * @param {string} [opts.name]
   * @param {string} [opts.topic]
   * @param {string[]} [opts.invite] - User IDs to invite at creation
   * @param {'public'|'private'} [opts.visibility='private']
   * @param {string[]} [opts.children] - Room IDs to add as m.space.child entries
   * @returns {Promise<{room_id: string}>}
   */
  async createSpace(opts = {}) {
    const visibility = opts.visibility || 'private';
    const body = {
      visibility,
      preset: visibility === 'public' ? 'public_chat' : 'private_chat',
      creation_content: { type: 'm.space' },
    };
    if (opts.name) body.name = opts.name;
    if (opts.topic) body.topic = opts.topic;
    if (Array.isArray(opts.invite) && opts.invite.length) body.invite = opts.invite;
    if (Array.isArray(opts.children) && opts.children.length) {
      body.initial_state = opts.children.map((childId) => ({
        type: 'm.space.child',
        state_key: childId,
        content: { via: [this._serverNameFromUserId()] },
      }));
    }
    return this._fetch('/_matrix/client/v3/createRoom', {
      method: 'POST',
      body: JSON.stringify(body),
    });
  }

  /**
   * Invite a user to a room or space. Matrix uses the same endpoint for
   * both — spaces are just rooms with a special creation type.
   */
  async inviteUser(roomId, userId) {
    return this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { method: 'POST', body: JSON.stringify({ user_id: userId }) },
    );
  }

  /**
   * Add a child room to a space by writing an `m.space.child` state event
   * on the space room. Requires the caller to have power level to send
   * state in the space.
   */
  async addRoomToSpace(spaceId, childRoomId, opts = {}) {
    const content = {
      via: opts.via || [this._serverNameFromUserId()],
    };
    if (opts.suggested) content.suggested = true;
    if (opts.order) content.order = opts.order;
    return this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childRoomId)}`,
      { method: 'PUT', body: JSON.stringify(content) },
    );
  }

  /**
   * Remove a child room from a space (sends an empty m.space.child content,
   * which Matrix treats as a tombstone for the child relationship).
   */
  async removeRoomFromSpace(spaceId, childRoomId) {
    return this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state/m.space.child/${encodeURIComponent(childRoomId)}`,
      { method: 'PUT', body: JSON.stringify({}) },
    );
  }

  /**
   * List the children of a space by reading its `m.space.child` state events.
   * Returns an array of `{ room_id, via, suggested, order }`.
   */
  async listSpaceChildren(spaceId) {
    try {
      const events = await this._fetch(
        `/_matrix/client/v3/rooms/${encodeURIComponent(spaceId)}/state`,
      );
      const out = [];
      for (const ev of events || []) {
        if (
          ev.type === 'm.space.child' &&
          ev.state_key &&
          ev.content &&
          Object.keys(ev.content).length > 0
        ) {
          out.push({
            room_id: ev.state_key,
            via: ev.content.via || [],
            suggested: !!ev.content.suggested,
            order: ev.content.order || null,
          });
        }
      }
      return out;
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') return [];
      if (e.status === 403) return [];
      throw e;
    }
  }

  _serverNameFromUserId() {
    if (!this.userId) return '';
    const at = this.userId.indexOf(':');
    return at === -1 ? '' : this.userId.slice(at + 1);
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

  // ── Profile management ───────────────────────────────────────────────────────

  /**
   * Fetch a Matrix profile (displayname + avatar mxc URI) for any user.
   * Unauthenticated on most homeservers; works for any visible userId.
   * Returns {displayname, avatar_url} with null fields when unset.
   *
   * @param {string} userId - full Matrix user id, e.g. "@alice:server"
   */
  async getProfile(userId) {
    try {
      const data = await this._fetch(
        `/_matrix/client/v3/profile/${encodeURIComponent(userId)}`,
      );
      return {
        displayname: data.displayname || null,
        avatar_url: data.avatar_url || null,
      };
    } catch (e) {
      if (e.status === 404 || e.errcode === 'M_NOT_FOUND') {
        return { displayname: null, avatar_url: null };
      }
      throw e;
    }
  }

  /**
   * Search the homeserver's user directory.
   * Wraps `POST /_matrix/client/v3/user_directory/search`. Note the server may
   * return only users it considers "visible" to the caller (rooms in common,
   * public profile, etc.) — for an exhaustive subnet roster prefer
   * `Subnet.listSubnetUsers()`.
   *
   * @param {string} searchTerm - substring of userId or displayname
   * @param {number} [limit=20]
   * @returns {Promise<{results: Array<{user_id: string, display_name: string|null, avatar_url: string|null}>, limited: boolean}>}
   */
  async searchUserDirectory(searchTerm, limit = 20) {
    return this._fetch('/_matrix/client/v3/user_directory/search', {
      method: 'POST',
      body: JSON.stringify({ search_term: String(searchTerm || ''), limit }),
    });
  }

  /**
   * Set the Matrix display name for the logged-in user.
   * @param {string} displayName
   */
  async setDisplayName(displayName) {
    return this._fetch(
      `/_matrix/client/v3/profile/${encodeURIComponent(this.userId)}/displayname`,
      { method: 'PUT', body: JSON.stringify({ displayname: displayName }) },
    );
  }

  /**
   * Set the Matrix avatar URL (must be an mxc:// URI).
   * Use uploadMedia() first to get the mxc:// URI from a local file.
   * @param {string} mxcUrl
   */
  async setAvatarUrl(mxcUrl) {
    return this._fetch(
      `/_matrix/client/v3/profile/${encodeURIComponent(this.userId)}/avatar_url`,
      { method: 'PUT', body: JSON.stringify({ avatar_url: mxcUrl }) },
    );
  }

  // ── Media upload / download ──────────────────────────────────────────────────

  /**
   * Upload binary data to the Matrix media repository.
   * @param {Buffer} buffer - File data
   * @param {string} contentType - MIME type (e.g. "image/png")
   * @param {string} [filename] - Optional filename hint
   * @returns {Promise<{content_uri: string}>} mxc:// URI of the uploaded file
   */
  async uploadMedia(buffer, contentType, filename) {
    const qs = filename ? `?filename=${encodeURIComponent(filename)}` : '';
    const res = await this._fetchRaw(`/_matrix/media/v3/upload${qs}`, {
      method: 'POST',
      headers: { 'Content-Type': contentType },
      body: buffer,
    });
    return res.json();
  }

  /**
   * Download a file from the Matrix media repository.
   * @param {string} mxcUrl - mxc:// URI (e.g. from an attachment)
   * @returns {Promise<Buffer>} Raw file bytes
   *
   * Note: files shared in E2E-encrypted rooms have their payload encrypted
   * with AES-CTR. This method downloads the raw (still-encrypted) bytes.
   * The attachment object returned by readMessages() includes an `encrypted`
   * flag when the file needs client-side decryption.
   */
  async downloadMedia(mxcUrl) {
    const match = mxcUrl.match(/^mxc:\/\/([^/]+)\/(.+)$/);
    if (!match) throw new Error(`Invalid mxc URL: ${mxcUrl}`);
    const [, serverName, mediaId] = match;
    const encodedServer = encodeURIComponent(serverName);
    const encodedMedia = encodeURIComponent(mediaId);
    // Try the authenticated media endpoint (Synapse ≥1.95 / Matrix 1.11)
    // and fall back to the unauthenticated v3 endpoint.
    let res;
    try {
      res = await this._fetchRaw(
        `/_matrix/client/v1/media/download/${encodedServer}/${encodedMedia}`,
      );
    } catch (e) {
      if (e.status !== 404 && e.errcode !== 'M_UNRECOGNIZED') throw e;
      res = await this._fetchRaw(
        `/_matrix/media/v3/download/${encodedServer}/${encodedMedia}`,
      );
    }
    return Buffer.from(await res.arrayBuffer());
  }

  /**
   * Download and decrypt an E2E-encrypted file shared in a Matrix room.
   *
   * @param {string} mxcUrl - mxc:// URI (from attachment.mxc_url)
   * @param {object} encryptInfo - EncryptedFile object from attachment.encrypt_info
   *   { url, key: {k, alg, ...}, iv, hashes: {sha256}, v }
   * @returns {Promise<Buffer>} Decrypted file bytes
   */
  async downloadMediaDecrypted(mxcUrl, encryptInfo) {
    const crypto = require('crypto');
    const ciphertext = await this.downloadMedia(mxcUrl);

    // Verify SHA-256 of ciphertext before decryption
    if (encryptInfo.hashes?.sha256) {
      const actualHash = crypto.createHash('sha256').update(ciphertext).digest('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const expectedHash = encryptInfo.hashes.sha256
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      if (actualHash !== expectedHash) {
        throw new Error(`SHA256 hash mismatch: got ${actualHash}, expected ${expectedHash}`);
      }
    }

    // base64url → Buffer
    const b64urlDecode = s => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    const key = b64urlDecode(encryptInfo.key.k);
    const iv = b64urlDecode(encryptInfo.iv);

    const decipher = crypto.createDecipheriv('aes-256-ctr', key, iv);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  async close() {
    if (this.olmMachine) {
      try { await this.olmMachine.close(); } catch {}
      this.olmMachine = null;
    }
    if (this.memoryStore) {
      this.memoryStore.close();
      this.memoryStore = null;
    }
  }
}

module.exports = { E2EMatrixClient };
