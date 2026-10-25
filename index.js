#!/usr/bin/env node
import { keccak_256 } from "@noble/hashes/sha3.js";

const VERSION = "0.69.0";
const IS_NODE = typeof window === "undefined";
const NODE_CRYPTO = "@matrix-org/matrix-sdk-crypto-nodejs";
const MEGOLM = "m.megolm.v1.aes-sha2";
const SPACE = "m.space";
const GENERAL_CHANNEL = "general";
const FILE_MSGTYPES = ["m.file", "m.image", "m.video", "m.audio"];
const BACKOFF_MS = [2000, 5000, 15000];
const NOTHING = { not_types: ["*"] };
const INITIAL_SYNC_FILTER = { room: { timeline: { limit: 0 }, state: NOTHING, ephemeral: NOTHING, account_data: NOTHING }, presence: NOTHING, account_data: NOTHING };
const SYNC_FILTER = { room: { timeline: { limit: 50 }, state: { lazy_load_members: true }, ephemeral: { types: ["m.typing"] }, account_data: NOTHING }, presence: NOTHING, account_data: NOTHING };
const HISTORY_VISIBILITY = { invited: "Invited", joined: "Joined", shared: "Shared", world_readable: "WorldReadable" };
const ROOM_COMMANDS = ["read", "send-file", "download", "leave", "invite", "kick", "members", "send", "edit", "react", "redact", "receipt", "typing"];
const MIME_TYPES = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", svg: "image/svg+xml", pdf: "application/pdf", txt: "text/plain", md: "text/markdown", json: "application/json", csv: "text/csv", mp4: "video/mp4", webm: "video/webm", mp3: "audio/mpeg", ogg: "audio/ogg", wav: "audio/wav", zip: "application/zip" };
const USAGE = `subnet <command>
  login <homeserver> --user <u> --password <p or - for stdin> [--name <device name>]
  register <homeserver> <username> <password or --password -> --token <registration token>
  accounts | logout [--server] | whoami [--server]
  rooms | invites | join <room or #alias> [--server] | leave <room>
  create-room --name N [--alias a] [--invite @a,@b] [--power @x=100,@y=50] [--server]
  create-network --name N [--alias a] [--server] | networks [--server]
  channels <network> | create-channel <network> --name N | remove-channel <network> <channel>
  invite <room> <user_id> | kick <room> <user_id> | members <room>
  read <room> [--limit 30] [--thread <root>]
  send <room> <text or -> [--reply-to <id>] [--thread <root>]
  edit <room> <event_id> <text> | react <room> <event_id> <emoji> | redact <room> <event_id>
  receipt <room> <event_id> | typing <room> on|off
  send-file <room> <path> [--thread <root>] | download <room> <event_id> <out_path>
  set-displayname <name> [--server]
  listen | watch [--network <network>] [--room <room>] [--server] | --version`;

const node_module = (name) => process.getBuiltinModule(name);
const node_require = (name) => node_module("node:module").createRequire(import.meta.url)(name);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const enc = encodeURIComponent;
const txn_id = () => `${Date.now()}_${Math.random().toString(36).slice(2)}`;
const url_safe = (b64) => b64.replace(/\+/g, "-").replace(/\//g, "_");

export function backup_key_message(homeserver) {
  return `Derive my encrypted message history backup key for ${new URL(homeserver).host}.\nOnly sign this on apps you trust, it can decrypt your message history.`;
}

export function backup_key_from_signature(signature) {
  return keccak_256(Uint8Array.from(signature.replace(/^0x/, "").match(/../g), (byte) => parseInt(byte, 16)));
}

export function localpart(user_id) {
  return user_id.slice(1, user_id.indexOf(":"));
}

function server_name(user_id) {
  return user_id.slice(user_id.indexOf(":") + 1);
}

export function project(raw_events, my_user_id, names) {
  const redacted = new Set(raw_events.filter((e) => e.type === "m.room.redaction").map((e) => e.redacts ?? e.content?.redacts));
  const events = raw_events.filter((e) => !redacted.has(e.event_id) && !e.unsigned?.redacted_because && Object.keys(e.content ?? {}).length);
  const by_id = new Map(events.map((e) => [e.event_id, e]));
  const edits = new Map();
  const reactions = new Map();
  for (const e of events) {
    const relation = e.content["m.relates_to"];
    if (e.type === "m.room.message" && relation?.rel_type === "m.replace" && e.content["m.new_content"] && by_id.get(relation.event_id)?.sender === e.sender && !(edits.get(relation.event_id)?.origin_server_ts > e.origin_server_ts)) edits.set(relation.event_id, e);
    if (e.type === "m.reaction" && relation?.rel_type === "m.annotation") {
      const by_key = reactions.get(relation.event_id) ?? new Map();
      reactions.set(relation.event_id, by_key.set(relation.key, [...(by_key.get(relation.key) ?? []), e]));
    }
  }
  return events.filter(is_message).map((e) => to_message(e, my_user_id, names, edits.get(e.event_id), reactions.get(e.event_id) ?? new Map()));
}

function is_message(e) {
  return (e.type === "m.room.message" || e.type === "m.room.encrypted") && e.content["m.relates_to"]?.rel_type !== "m.replace";
}

function to_message(e, my_user_id, names, edit, reactions) {
  const content = e.content;
  const relation = content["m.relates_to"] ?? {};
  const thread_root = relation.rel_type === "m.thread" ? relation.event_id : null;
  const undecryptable = e.type === "m.room.encrypted";
  const has_file = !undecryptable && FILE_MSGTYPES.includes(content.msgtype);
  return {
    event_id: e.event_id,
    room_id: e.room_id,
    sender: e.sender,
    sender_name: names?.[e.sender] ?? localpart(e.sender),
    ts: e.origin_server_ts,
    msgtype: undecryptable ? null : content.msgtype,
    body: undecryptable ? "Unable to decrypt this message" : edit ? edit.content["m.new_content"].body : content.body,
    thread_root,
    reply_to: thread_root && relation.is_falling_back ? null : relation["m.in_reply_to"]?.event_id ?? null,
    edited: !!edit,
    attachment: has_file ? { name: content.filename ?? content.body, mime: content.info?.mimetype ?? null, size: content.info?.size ?? null, mxc: content.file?.url ?? content.url, file: content.file ?? null } : null,
    reactions: [...reactions].map(([key, list]) => ({ key, count: list.length, mine: list.some((r) => r.sender === my_user_id), my_event_id: list.find((r) => r.sender === my_user_id)?.event_id ?? null, senders: list.map((r) => r.sender) })),
    mine: e.sender === my_user_id,
    undecryptable,
    encrypted: !!e.encrypted,
    verified: !!e.verified,
  };
}

function clear_event(raw, type, content) {
  const relation = raw.content["m.relates_to"];
  return { ...raw, type, content: relation && !content["m.relates_to"] ? { ...content, "m.relates_to": relation } : content, encrypted: true };
}

function invite_info(room_id, events, user_id) {
  return { room_id, inviter: events.find((e) => e.type === "m.room.member" && e.state_key === user_id)?.sender ?? null, room_name: events.find((e) => e.type === "m.room.name")?.content.name ?? null };
}

function relation_content(thread_root, reply_to) {
  if (thread_root) return { "m.relates_to": { rel_type: "m.thread", event_id: thread_root, is_falling_back: !reply_to, "m.in_reply_to": { event_id: reply_to ?? thread_root } } };
  return reply_to ? { "m.relates_to": { "m.in_reply_to": { event_id: reply_to } } } : {};
}

function to_b64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary).replace(/=+$/, "");
}

function from_b64(text) {
  const normal = text.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(normal + "=".repeat((4 - (normal.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

async function encrypt_attachment(bytes) {
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = new Uint8Array(16);
  iv.set(crypto.getRandomValues(new Uint8Array(8)));
  const aes = await crypto.subtle.importKey("raw", key, "AES-CTR", false, ["encrypt"]);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-CTR", counter: iv, length: 64 }, aes, bytes));
  const sha256 = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return { data, info: { v: "v2", key: { kty: "oct", alg: "A256CTR", ext: true, k: url_safe(to_b64(key)), key_ops: ["encrypt", "decrypt"] }, iv: to_b64(iv), hashes: { sha256: to_b64(sha256) } } };
}

async function decrypt_attachment(data, file) {
  const sha256 = to_b64(new Uint8Array(await crypto.subtle.digest("SHA-256", data)));
  if (url_safe(sha256) !== url_safe(file.hashes.sha256.replace(/=+$/, ""))) throw new Error("Attachment hash mismatch");
  const aes = await crypto.subtle.importKey("raw", from_b64(file.key.k), "AES-CTR", false, ["decrypt"]);
  return new Uint8Array(await crypto.subtle.decrypt({ name: "AES-CTR", counter: from_b64(file.iv), length: 64 }, aes, data));
}

async function delete_crypto_databases(prefix) {
  for (const db of await indexedDB.databases()) {
    if (db.name.startsWith(`${prefix}::`)) await new Promise((resolve) => Object.assign(indexedDB.deleteDatabase(db.name), { onsuccess: resolve, onerror: resolve, onblocked: resolve }));
  }
}

function hold_tab_lock(name) {
  return new Promise((resolve, reject) => navigator.locks.request(name, { ifAvailable: true }, (lock) => (lock ? new Promise((release) => resolve(release)) : reject(new Error("Group chat is open in another tab")))));
}

function is_transient(e) {
  return e.name === "TypeError" || e.name === "AbortError" || e.status >= 500;
}

async function matrix_request(homeserver, token, method, path, body, options) {
  const binary = body instanceof Uint8Array;
  const headers = { ...(body === undefined ? {} : { "Content-Type": binary ? "application/octet-stream" : "application/json" }), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const response = await fetch(homeserver + path, { method, headers, body: body === undefined || binary || typeof body === "string" ? body : JSON.stringify(body), signal: options?.signal });
  if (response.ok) return options?.raw ? response : response.json();
  const text = await response.text();
  const data = text.startsWith("{") ? JSON.parse(text) : { error: text };
  if (response.status === 429) {
    await sleep(Math.min((data.retry_after_ms ?? 1000) + 500, 60000));
    return matrix_request(homeserver, token, method, path, body, options);
  }
  throw Object.assign(new Error(data.error || `${method} ${path} failed with ${response.status}`), { status: response.status, errcode: data.errcode, data });
}

export async function register(homeserver, username, password, token) {
  const body = { username, password, inhibit_login: true };
  try {
    return await matrix_request(homeserver, null, "POST", "/_matrix/client/v3/register", body);
  } catch (e) {
    if (e.status !== 401) throw e;
    return matrix_request(homeserver, null, "POST", "/_matrix/client/v3/register", { ...body, auth: { type: "m.login.registration_token", token, session: e.data.session } });
  }
}

export class MatrixClient {
  constructor({ homeserver, username, password, store_name, device_name, derive_backup_key }) {
    this.homeserver = homeserver.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.store_name = store_name;
    this.device_name = device_name ?? "subnet-client";
    this.derive_backup_key = derive_backup_key;
    this.token = null;
    this.user_id = null;
    this.device_id = null;
    this.next_batch = null;
    this.olm = null;
    this.mx = null;
    this.crypto_ready = Promise.resolve();
    this._lock = Promise.resolve();
    this._listening = false;
    this._stops = [];
    this._undecrypted = new Map();
    this._pending = new Set();
    this._deferred = new Set();
    this._backup_key = null;
    this._batch = null;
    this._emitting = Promise.resolve();
  }

  _request(method, path, body, options) {
    return matrix_request(this.homeserver, this.token, method, path, body, options);
  }

  _locked(fn) {
    const run = this._lock.then(fn);
    this._lock = run.catch(() => null);
    return run;
  }

  session() {
    return { homeserver: this.homeserver, user_id: this.user_id, device_id: this.device_id };
  }

  async login() {
    return IS_NODE ? this._node_login() : this._browser_login();
  }

  async _resume(session) {
    if (!session) return;
    Object.assign(this, { token: session.access_token, user_id: session.user_id, device_id: session.device_id });
    try {
      await this._request("GET", "/_matrix/client/v3/account/whoami");
    } catch (e) {
      if (e.status !== 401 && e.errcode !== "M_UNKNOWN_TOKEN") throw e;
      this.token = null;
    }
  }

  async _password_login() {
    const response = await this._request("POST", "/_matrix/client/v3/login", { type: "m.login.password", identifier: { type: "m.id.user", user: this.username }, password: this.password, initial_device_display_name: this.device_name });
    Object.assign(this, { token: response.access_token, user_id: response.user_id, device_id: response.device_id });
  }

  async _node_login() {
    this._fs = node_module("node:fs");
    this._nc = node_require(NODE_CRYPTO);
    this._fs.mkdirSync(this.store_name, { recursive: true, mode: 0o700 });
    this._session_path = `${this.store_name}/session.json`;
    const crypto_path = `${this.store_name}/crypto`;
    const session = this._fs.existsSync(this._session_path) ? JSON.parse(this._fs.readFileSync(this._session_path, "utf8")) : null;
    if (!session && this._fs.existsSync(crypto_path)) throw new Error(`${crypto_path} exists without session.json, delete ${this.store_name} to start over`);
    await this._resume(session);
    if (!this.token) this._fs.rmSync(crypto_path, { recursive: true, force: true });
    if (!this.token) await this._password_login();
    this.next_batch = session?.next_batch ?? null;
    this.master_keys = session?.master_keys ?? {};
    this._node_save();
    this.olm = await this._nc.OlmMachine.initialize(new this._nc.UserId(this.user_id), new this._nc.DeviceId(this.device_id), crypto_path);
    await this._locked(() => this._process_outgoing());
    await this._ensure_cross_signing();
  }

  _node_save() {
    this._fs.writeFileSync(this._session_path, JSON.stringify({ user_id: this.user_id, device_id: this.device_id, access_token: this.token, next_batch: this.next_batch, master_keys: this.master_keys }), { mode: 0o600 });
  }

  async _browser_login() {
    this._release_tab = await hold_tab_lock(this.store_name);
    await this._browser_session().catch((e) => {
      this._release_tab();
      throw e;
    });
  }

  async _browser_session() {
    this.sdk = await import("matrix-js-sdk");
    const session = JSON.parse(localStorage.getItem(`${this.store_name}::session`));
    const crypto_device = localStorage.getItem(`${this.store_name}::crypto_device`);
    await this._resume(session?.device_id === crypto_device ? session : null);
    if (!this.token) await this._password_login();
    localStorage.setItem(`${this.store_name}::session`, JSON.stringify({ user_id: this.user_id, device_id: this.device_id, access_token: this.token }));
    this.mx = this.sdk.createClient({ baseUrl: this.homeserver, accessToken: this.token, userId: this.user_id, deviceId: this.device_id, timelineSupport: true, disableVoip: true, cryptoCallbacks: { getSecretStorageKey: (request) => this._secret_storage_key(request) } });
    if (crypto_device !== this.device_id) await delete_crypto_databases(this.store_name);
    await this.mx.initRustCrypto({ cryptoDatabasePrefix: this.store_name });
    localStorage.setItem(`${this.store_name}::crypto_device`, this.device_id);
    await this.mx.startClient({ initialSyncLimit: 30 });
    while (!["PREPARED", "SYNCING"].includes(this.mx.getSyncState())) await new Promise((resolve) => this.mx.once(this.sdk.ClientEvent.Sync, resolve));
    this.crypto_ready = this._crypto_extras();
    this.crypto_ready.catch((e) => console.warn("subnet-client: key backup setup skipped", e));
  }

  async _backup_key_bytes() {
    this._backup_key ??= this._load_backup_key().catch((e) => {
      this._backup_key = null;
      throw e;
    });
    const key = await this._backup_key;
    if (!key) this._backup_key = null;
    return key;
  }

  async _load_backup_key() {
    const stored = localStorage.getItem(`${this.store_name}::backup_key`);
    if (stored) return Uint8Array.from(JSON.parse(stored));
    const key = this.derive_backup_key ? await this.derive_backup_key() : null;
    if (key) localStorage.setItem(`${this.store_name}::backup_key`, JSON.stringify([...key]));
    return key;
  }

  async _secret_storage_key({ keys }) {
    const key = await this._backup_key_bytes();
    if (!key) return null;
    const default_id = await this.mx.secretStorage.getDefaultKeyId();
    return [keys[default_id] ? default_id : Object.keys(keys)[0], key];
  }

  async _auth_upload(make_request) {
    try {
      await make_request(null);
    } catch (e) {
      if (e.httpStatus !== 401) throw e;
      await make_request({ type: "m.login.password", identifier: { type: "m.id.user", user: this.user_id }, password: this.password, session: e.data.session });
    }
  }

  async _cross_signing_usable(crypto_api) {
    if (!(await crypto_api.userHasCrossSigningKeys(this.user_id, true))) return true;
    const status = await crypto_api.getCrossSigningStatus();
    return status.privateKeysInSecretStorage || Object.values(status.privateKeysCachedLocally).every(Boolean);
  }

  async _server_backup() {
    try {
      return await this._request("GET", "/_matrix/client/v3/room_keys/version");
    } catch (e) {
      if (e.errcode !== "M_NOT_FOUND") throw e;
      return null;
    }
  }

  async _backup_check(crypto_api) {
    const check = await crypto_api.checkKeyBackupAndEnable();
    if (!check) throw new Error("Key backup check failed");
    return check;
  }

  async _adopt_key_backup(crypto_api) {
    if (!(await this._server_backup())) return false;
    await this._backup_check(crypto_api);
    await crypto_api.loadSessionBackupPrivateKeyFromSecretStorage().catch((e) => console.warn("subnet-client: backup key not in secret storage", e));
    const { trustInfo } = await this._backup_check(crypto_api);
    return trustInfo.matchesDecryptionKey || trustInfo.trusted;
  }

  async _crypto_extras() {
    const crypto_api = this.mx.getCrypto();
    const key = await this._backup_key_bytes();
    if (!key) return;
    await crypto_api.bootstrapSecretStorage({ createSecretStorageKey: async () => ({ privateKey: key, keyInfo: { name: "Wallet derived message history key" } }) });
    if (await this._cross_signing_usable(crypto_api)) await crypto_api.bootstrapCrossSigning({ authUploadDeviceSigningKeys: (make_request) => this._auth_upload(make_request) });
    if (!(await this._adopt_key_backup(crypto_api))) await crypto_api.resetKeyBackup();
    await crypto_api.restoreKeyBackup();
  }

  async security_key() {
    const key = IS_NODE ? null : await this._backup_key_bytes();
    if (!key) return null;
    const { encodeRecoveryKey } = await import("matrix-js-sdk/lib/crypto-api/recovery-key.js");
    return encodeRecoveryKey(key);
  }

  async _process_outgoing() {
    for (const request of await this.olm.outgoingRequests()) await this._outgoing(request);
  }

  async _outgoing(request) {
    const { RequestType } = this._nc;
    const body = JSON.parse(request.body);
    const routes = {
      [RequestType.KeysUpload]: ["POST", "/_matrix/client/v3/keys/upload", body],
      [RequestType.KeysQuery]: ["POST", "/_matrix/client/v3/keys/query", body],
      [RequestType.KeysClaim]: ["POST", "/_matrix/client/v3/keys/claim", body],
      [RequestType.SignatureUpload]: ["POST", "/_matrix/client/v3/keys/signatures/upload", body.signed_keys ?? body],
      [RequestType.ToDevice]: ["PUT", `/_matrix/client/v3/sendToDevice/${enc(request.eventType)}/${enc(request.txnId ?? txn_id())}`, body],
      [RequestType.RoomMessage]: ["PUT", `/_matrix/client/v3/rooms/${enc(request.roomId)}/send/${enc(request.eventType)}/${enc(request.txnId)}`, body],
    };
    const response = await this._request(...routes[request.type]);
    if (request.type === RequestType.KeysQuery) this._pin_master_keys(response.master_keys ?? {});
    await this.olm.markRequestAsSent(request.id, request.type, JSON.stringify(response));
  }

  _pin_master_keys(master_keys) {
    for (const [user_id, info] of Object.entries(master_keys)) {
      const key = Object.values(info.keys)[0];
      if (!this.master_keys[user_id]?.includes(key)) this.master_keys[user_id] = [...(this.master_keys[user_id] ?? []), key];
    }
    this._node_save();
  }

  async _uia(method, path, body) {
    try {
      return await this._request(method, path, body);
    } catch (e) {
      if (e.status !== 401 || !e.data.session) throw e;
      return this._request(method, path, { ...body, auth: { type: "m.login.password", identifier: { type: "m.id.user", user: this.user_id }, password: this.password, session: e.data.session } });
    }
  }

  async _ensure_cross_signing() {
    const status = await this.olm.crossSigningStatus();
    if (status.hasMaster && status.hasSelfSigning && status.hasUserSigning) return;
    const server = await this._request("POST", "/_matrix/client/v3/keys/query", { device_keys: { [this.user_id]: [] } });
    if (server.master_keys?.[this.user_id]) return;
    const requests = await this.olm.bootstrapCrossSigning(true);
    await this._locked(async () => {
      if (requests.uploadKeysReq) await this._outgoing(requests.uploadKeysReq);
      await this._uia("POST", "/_matrix/client/v3/keys/device_signing/upload", JSON.parse(requests.uploadSigningKeysReq));
      await this._outgoing(requests.uploadSignaturesReq);
    });
  }

  async _sync(timeout, signal, keep_position) {
    const { DeviceLists, UserId } = this._nc;
    const params = new URLSearchParams({ timeout: String(timeout), filter: JSON.stringify(this.next_batch && !keep_position ? SYNC_FILTER : INITIAL_SYNC_FILTER) });
    if (this.next_batch) params.set("since", this.next_batch);
    const sync = await this._request("GET", `/_matrix/client/v3/sync?${params}`, undefined, { signal });
    await this._locked(async () => {
      const lists = new DeviceLists((sync.device_lists?.changed ?? []).map((u) => new UserId(u)), (sync.device_lists?.left ?? []).map((u) => new UserId(u)));
      await this.olm.receiveSyncChanges(JSON.stringify(sync.to_device?.events ?? []), lists, sync.device_one_time_keys_count ?? {}, sync.device_unused_fallback_key_types ?? []);
      await this._process_outgoing();
    });
    if (keep_position) return sync;
    this.next_batch = sync.next_batch;
    this._node_save();
    return sync;
  }

  async _catch_up() {
    if (IS_NODE && !this._listening) await this._sync(0, undefined, true);
  }

  async _share_room_key(room_id) {
    const { UserId, RoomId, EncryptionSettings, HistoryVisibility } = this._nc;
    const users = (await this.members(room_id)).filter((m) => m.membership === "join").map((m) => new UserId(m.user_id));
    await this.olm.updateTrackedUsers(users);
    await this._outgoing(this.olm.queryKeysForUsers(users));
    await this._process_outgoing();
    const claim = await this.olm.getMissingSessions(users);
    if (claim) await this._outgoing(claim);
    const settings = new EncryptionSettings();
    settings.historyVisibility = HistoryVisibility[HISTORY_VISIBILITY[(await this._state(room_id, "m.room.history_visibility"))?.history_visibility ?? "shared"]];
    for (const request of await this.olm.shareRoomKey(new RoomId(room_id), users, settings)) await this._outgoing(request);
    await this._process_outgoing();
  }

  async _decrypt(room_id, raws) {
    const events = raws.map((raw) => ({ ...raw, room_id }));
    if (!IS_NODE) return this._browser_decrypt(events);
    const out = [];
    for (const raw of events) out.push(raw.type === "m.room.encrypted" && raw.content.ciphertext ? await this._node_decrypt(raw) : raw);
    return out;
  }

  async _node_decrypt(raw) {
    const { RoomId, UserId, ShieldStateCode } = this._nc;
    await this._locked(async () => {
      await this.olm.updateTrackedUsers([new UserId(raw.sender)]);
      await this._process_outgoing();
    });
    const decrypted = await this.olm.decryptRoomEvent(JSON.stringify(raw), new RoomId(raw.room_id)).catch(() => null);
    if (!decrypted) {
      this._undecrypted.set(raw.event_id, raw);
      if (this._undecrypted.size > 500) this._undecrypted.delete(this._undecrypted.keys().next().value);
      return raw;
    }
    this._undecrypted.delete(raw.event_id);
    const event = JSON.parse(decrypted.event);
    const verified = decrypted.shieldState(false)?.code === ShieldStateCode.None && this.master_keys[raw.sender]?.length === 1;
    return { ...clear_event(raw, event.type, event.content), verified };
  }

  async _browser_decrypt(raws) {
    const mapper = this.mx.getEventMapper();
    const events = raws.map((raw) => mapper(raw));
    await Promise.all(events.map((ev) => this.mx.decryptEventIfNeeded(ev)));
    return events.map((ev) => this._raw(ev));
  }

  _raw(ev) {
    if (!ev.isEncrypted() || ev.isRedacted()) return ev.event;
    if (ev.isDecryptionFailure()) {
      this._pending.add(ev.getId());
      return ev.event;
    }
    return clear_event(ev.event, ev.getType(), ev.getOriginalContent());
  }

  async _send_event(room_id, type, content) {
    if (!IS_NODE) {
      while (!this.mx.getRoom(room_id)) await new Promise((resolve) => this.mx.once(this.sdk.ClientEvent.Room, resolve));
      if (!(await this.mx.getCrypto().isEncryptionEnabledInRoom(room_id))) throw new Error("This room is not end to end encrypted");
      return (await this.mx.sendEvent(room_id, null, type, content)).event_id;
    }
    await this._catch_up();
    const body = await this._locked(async () => {
      await this._share_room_key(room_id);
      return this.olm.encryptRoomEvent(new this._nc.RoomId(room_id), type, JSON.stringify(content));
    });
    return (await this._request("PUT", `/_matrix/client/v3/rooms/${enc(room_id)}/send/m.room.encrypted/${txn_id()}`, body)).event_id;
  }

  async _state(room_id, type) {
    try {
      return await this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/state/${enc(type)}/`);
    } catch (e) {
      if (e.errcode !== "M_NOT_FOUND") throw e;
      return null;
    }
  }

  async _thread_root(room_id, event_id) {
    const relation = (await this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/event/${enc(event_id)}`)).content["m.relates_to"];
    return relation?.rel_type === "m.thread" ? relation.event_id : event_id;
  }

  async close() {
    for (const stop of this._stops) stop();
    this._stops = [];
    await this._listen_done;
    if (this.mx) this.mx.stopClient();
    this._release_tab?.();
    if (this.olm) await this._locked(() => this.olm.close());
    this.olm = null;
  }

  async logout() {
    await this._request("POST", "/_matrix/client/v3/logout", {});
    await this.close();
    if (IS_NODE) return node_module("node:fs").rmSync(this.store_name, { recursive: true, force: true });
    for (const name of ["session", "crypto_device", "backup_key"]) localStorage.removeItem(`${this.store_name}::${name}`);
    await delete_crypto_databases(this.store_name);
  }

  async create_room({ name, topic, alias, invite, preset, visibility, power_users }) {
    const body = { name, topic, room_alias_name: alias, invite, preset: preset ?? "public_chat", visibility: visibility ?? "private", initial_state: [{ type: "m.room.encryption", state_key: "", content: { algorithm: MEGOLM } }] };
    if (power_users) body.power_level_content_override = { users: power_users };
    return (await this._request("POST", "/_matrix/client/v3/createRoom", body)).room_id;
  }

  async join(room_id_or_alias) {
    if (!IS_NODE) return (await this.mx.joinRoom(room_id_or_alias)).roomId;
    const { room_id } = await this._request("POST", `/_matrix/client/v3/join/${enc(room_id_or_alias)}`, {});
    await this._catch_up();
    await this._locked(() => this._share_room_key(room_id));
    return room_id;
  }

  async leave(room_id) {
    await this._request("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/leave`, {});
    await this._request("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/forget`, {});
  }

  async invite(room_id, user_id) {
    await this._request("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/invite`, { user_id });
  }

  async kick(room_id, user_id, reason) {
    await this._request("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/kick`, { user_id, reason });
  }

  async members(room_id) {
    const { chunk } = await this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/members`);
    return chunk.map((e) => ({ user_id: e.state_key, display_name: e.content.displayname ?? null, avatar_url: e.content.avatar_url ?? null, membership: e.content.membership }));
  }

  async room_name(room_id) {
    return (await this._state(room_id, "m.room.name"))?.name ?? null;
  }

  async set_room_name(room_id, name) {
    await this._request("PUT", `/_matrix/client/v3/rooms/${enc(room_id)}/state/m.room.name/`, { name });
  }

  async _all_state(room_id) {
    return this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/state`);
  }

  async create_network({ name, alias }) {
    const room_id = (await this._request("POST", "/_matrix/client/v3/createRoom", { name, room_alias_name: alias, preset: "public_chat", visibility: "private", creation_content: { type: SPACE }, power_level_content_override: { events: { "m.space.child": 0, "m.room.name": 50, "m.room.power_levels": 100 } } })).room_id;
    return { room_id, general: await this.create_channel(room_id, GENERAL_CHANNEL) };
  }

  async create_channel(network_id, name) {
    const via = [server_name(this.user_id)];
    const initial_state = [
      { type: "m.room.encryption", state_key: "", content: { algorithm: MEGOLM } },
      { type: "m.room.join_rules", state_key: "", content: { join_rule: "restricted", allow: [{ type: "m.room_membership", room_id: network_id }] } },
      { type: "m.space.parent", state_key: network_id, content: { via, canonical: true } },
    ];
    const room_id = (await this._request("POST", "/_matrix/client/v3/createRoom", { name, preset: "private_chat", visibility: "private", initial_state, power_level_content_override: { events: { "m.room.name": 0, "m.room.power_levels": 100 } } })).room_id;
    await this._request("PUT", `/_matrix/client/v3/rooms/${enc(network_id)}/state/m.space.child/${enc(room_id)}`, { via });
    for (const m of await this.members(network_id)) if (m.membership === "join" && m.user_id !== this.user_id) await this.invite(room_id, m.user_id);
    return room_id;
  }

  async remove_channel(network_id, room_id) {
    await this._request("PUT", `/_matrix/client/v3/rooms/${enc(network_id)}/state/m.space.child/${enc(room_id)}`, {});
  }

  async channels(network_id) {
    return (await this._all_state(network_id)).filter((e) => e.type === "m.space.child" && e.content.via?.length).map((e) => e.state_key);
  }

  async network_of(room_id) {
    return (await this._all_state(room_id)).find((e) => e.type === "m.space.parent")?.state_key ?? null;
  }

  async is_network(room_id) {
    return (await this._state(room_id, "m.room.create"))?.type === SPACE;
  }

  async join_network(room_id_or_alias) {
    const room_id = await this.join(room_id_or_alias);
    const channels = await this.channels(room_id);
    for (const channel of channels) await this.join(channel);
    return { room_id, channels };
  }

  async resolve(room_id_or_alias) {
    if (!room_id_or_alias.startsWith("#")) return room_id_or_alias;
    return (await this._request("GET", `/_matrix/client/v3/directory/room/${enc(room_id_or_alias)}`)).room_id;
  }

  async joined_rooms() {
    return (await this._request("GET", "/_matrix/client/v3/joined_rooms")).joined_rooms;
  }

  async invites() {
    const sync = await this._request("GET", `/_matrix/client/v3/sync?${new URLSearchParams({ timeout: "0", filter: JSON.stringify(INITIAL_SYNC_FILTER) })}`);
    return Object.entries(sync.rooms?.invite ?? {}).map(([room_id, room]) => invite_info(room_id, room.invite_state?.events ?? [], this.user_id));
  }

  async messages(room_id, { from, limit } = {}) {
    await this._catch_up();
    const params = new URLSearchParams({ dir: "b", limit: String(limit ?? 30), ...(from ? { from } : {}) });
    const data = await this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/messages?${params}`);
    return { events: (await this._decrypt(room_id, data.chunk)).reverse(), end: data.end ?? null };
  }

  async thread(room_id, root_id, { from, limit } = {}) {
    await this._catch_up();
    const params = new URLSearchParams({ dir: "b", limit: String(limit ?? 30), ...(from ? { from } : {}) });
    const data = await this._request("GET", `/_matrix/client/v1/rooms/${enc(room_id)}/relations/${enc(root_id)}/m.thread?${params}`);
    const root = from ? [] : [await this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/event/${enc(root_id)}`)];
    const events = [...root, ...data.chunk.reverse()];
    const edits = await Promise.all(events.map((e) => this._request("GET", `/_matrix/client/v1/rooms/${enc(room_id)}/relations/${enc(e.event_id)}/m.replace?dir=b&limit=1`)));
    return { events: await this._decrypt(room_id, [...events, ...edits.flatMap((r) => r.chunk)]), end: data.next_batch ?? null };
  }

  async event(room_id, event_id) {
    await this._catch_up();
    return (await this._decrypt(room_id, [await this._request("GET", `/_matrix/client/v3/rooms/${enc(room_id)}/event/${enc(event_id)}`)]))[0];
  }

  async send(room_id, text, { reply_to, thread_root, msgtype } = {}) {
    const root = thread_root ? await this._thread_root(room_id, thread_root) : null;
    return this._send_event(room_id, "m.room.message", { msgtype: msgtype ?? "m.text", body: text, ...relation_content(root, reply_to) });
  }

  async send_file(room_id, file, { name, mime, thread_root, reply_to } = {}) {
    const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer());
    const { data, info } = await encrypt_attachment(bytes);
    const { content_uri } = await this._request("POST", `/_matrix/media/v3/upload?filename=${enc(name)}`, data);
    const msgtype = { image: "m.image", video: "m.video", audio: "m.audio" }[mime.split("/")[0]] ?? "m.file";
    const root = thread_root ? await this._thread_root(room_id, thread_root) : null;
    return this._send_event(room_id, "m.room.message", { msgtype, body: name, filename: name, info: { mimetype: mime, size: bytes.length }, file: { ...info, url: content_uri }, ...relation_content(root, reply_to) });
  }

  async edit(room_id, event_id, text) {
    return this._send_event(room_id, "m.room.message", { msgtype: "m.text", body: `* ${text}`, "m.new_content": { msgtype: "m.text", body: text }, "m.relates_to": { rel_type: "m.replace", event_id } });
  }

  async react(room_id, event_id, key) {
    return (await this._request("PUT", `/_matrix/client/v3/rooms/${enc(room_id)}/send/m.reaction/${txn_id()}`, { "m.relates_to": { rel_type: "m.annotation", event_id, key } })).event_id;
  }

  async redact(room_id, event_id, reason) {
    return (await this._request("PUT", `/_matrix/client/v3/rooms/${enc(room_id)}/redact/${enc(event_id)}/${txn_id()}`, { reason })).event_id;
  }

  async read_receipt(room_id, event_id) {
    await this._request("POST", `/_matrix/client/v3/rooms/${enc(room_id)}/read_markers`, { "m.fully_read": event_id, "m.read": event_id });
  }

  async typing(room_id, on, timeout_ms) {
    await this._request("PUT", `/_matrix/client/v3/rooms/${enc(room_id)}/typing/${enc(this.user_id)}`, { typing: on, timeout: timeout_ms ?? 30000 });
  }

  async download(attachment) {
    const [server, media_id] = attachment.mxc.slice("mxc://".length).split("/");
    const response = await this._request("GET", `/_matrix/client/v1/media/download/${enc(server)}/${enc(media_id)}`, undefined, { raw: true });
    const data = new Uint8Array(await response.arrayBuffer());
    const bytes = attachment.file ? await decrypt_attachment(data, attachment.file) : data;
    return IS_NODE ? bytes : new Blob([bytes], { type: attachment.mime ?? "application/octet-stream" });
  }

  async set_displayname(name) {
    await this._request("PUT", `/_matrix/client/v3/profile/${enc(this.user_id)}/displayname`, { displayname: name });
  }

  async profile(user_id) {
    return this._request("GET", `/_matrix/client/v3/profile/${enc(user_id)}`);
  }

  listen(on_batch) {
    return IS_NODE ? this._node_listen(on_batch) : this._browser_listen(on_batch);
  }

  _node_listen(on_batch) {
    this._listening = true;
    const controller = new AbortController();
    const stop = () => controller.abort();
    this._stops.push(stop);
    this._listen_done = this._listen_loop(on_batch, controller.signal);
    return { stop };
  }

  async _listen_loop(on_batch, signal) {
    let failures = 0;
    while (!signal.aborted) {
      const sync = await this._sync(this.next_batch ? 30000 : 0, signal).catch((e) => e);
      if (signal.aborted) return;
      if (sync instanceof Error && !is_transient(sync)) throw sync;
      if (sync instanceof Error) {
        console.warn(`subnet-client: sync with ${this.homeserver} failed, retrying: ${sync.message}`);
        await sleep(BACKOFF_MS[Math.min(failures++, BACKOFF_MS.length - 1)]);
        continue;
      }
      failures = 0;
      const batch = await this._node_batch(sync);
      if (Object.keys(batch.rooms).length || batch.invites.length || batch.left.length) await on_batch(batch);
    }
  }

  async _node_batch(sync) {
    const rooms = {};
    if (sync.to_device?.events?.length) {
      for (const raw of [...this._undecrypted.values()]) {
        const event = await this._node_decrypt(raw);
        if (event.encrypted) (rooms[raw.room_id] ??= { events: [], state: [] }).events.push(event);
      }
    }
    for (const [room_id, room] of Object.entries(sync.rooms?.join ?? {})) {
      const typing = (room.ephemeral?.events ?? []).filter((e) => e.type === "m.typing").map((e) => ({ type: e.type, content: e.content }));
      const events = [...(await this._decrypt(room_id, room.timeline?.events ?? [])), ...typing];
      const state = room.state?.events ?? [];
      if (events.length || state.length) {
        const entry = (rooms[room_id] ??= { events: [], state: [] });
        entry.events.push(...events);
        entry.state.push(...state);
      }
    }
    return { rooms, invites: Object.entries(sync.rooms?.invite ?? {}).map(([room_id, room]) => invite_info(room_id, room.invite_state?.events ?? [], this.user_id)), left: Object.keys(sync.rooms?.leave ?? {}) };
  }

  _browser_listen(on_batch) {
    const { RoomEvent, MatrixEventEvent, RoomMemberEvent } = this.sdk;
    this._on_batch = on_batch;
    const handlers = [
      [RoomEvent.Timeline, (ev, room, to_start, removed, data) => this._on_timeline(ev, room, to_start, removed, data)],
      [MatrixEventEvent.Decrypted, (ev) => this._on_decrypted(ev)],
      [RoomEvent.LocalEchoUpdated, (ev, room) => this._on_local_echo(ev, room)],
      [RoomEvent.MyMembership, (room, membership) => this._on_membership(room, membership)],
      [RoomMemberEvent.Typing, (ev, member) => this._on_typing(ev, member)],
    ];
    for (const [name, handler] of handlers) this.mx.on(name, handler);
    const stop = () => handlers.forEach(([name, handler]) => this.mx.off(name, handler));
    this._stops.push(stop);
    return { stop };
  }

  _on_timeline(ev, room, to_start, removed, data) {
    if (to_start || removed || !data.liveEvent || ev.status) return;
    if (ev.isBeingDecrypted() || ev.shouldAttemptDecryption()) return void this._deferred.add(ev.getId());
    this._queue(room.roomId, this._raw(ev));
  }

  _on_decrypted(ev) {
    if (!this._deferred.delete(ev.getId()) && (ev.isDecryptionFailure() || !this._pending.delete(ev.getId()))) return;
    this._queue(ev.getRoomId(), this._raw(ev));
  }

  _on_local_echo(ev, room) {
    if (ev.status || !ev.getId().startsWith("$")) return;
    this._queue(room.roomId, this._raw(ev));
  }

  _on_membership(room, membership) {
    this._batch ??= { rooms: {}, invites: [], left: [] };
    if (membership === "invite") this._batch.invites.push({ room_id: room.roomId, inviter: room.getMember(this.user_id)?.events.member?.getSender() ?? null, room_name: room.name });
    if (membership === "leave" || membership === "ban") this._batch.left.push(room.roomId);
    this._flush_soon();
  }

  _on_typing(ev, member) {
    const entry = this._room_batch(member.roomId);
    entry.events = [...entry.events.filter((e) => e.type !== "m.typing"), { type: "m.typing", content: ev.getContent() }];
    this._flush_soon();
  }

  _room_batch(room_id) {
    this._batch ??= { rooms: {}, invites: [], left: [] };
    return (this._batch.rooms[room_id] ??= { events: [], state: [] });
  }

  _queue(room_id, raw) {
    this._room_batch(room_id).events.push(raw);
    this._flush_soon();
  }

  _flush_soon() {
    if (this._flush_timer) return;
    this._flush_timer = setTimeout(() => this._flush(), 0);
  }

  _flush() {
    this._flush_timer = null;
    const batch = this._batch;
    this._batch = null;
    this._emitting = this._emitting.then(() => this._on_batch(batch));
  }
}

function parse_args(argv) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) flags[argv[i].slice(2)] = argv[++i];
    else args.push(argv[i]);
  }
  return { args, flags };
}

function normalize_homeserver(homeserver) {
  return (homeserver.includes("://") ? homeserver : `https://${homeserver}`).replace(/\/+$/, "");
}

function pid_alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM";
  }
}

class Cli {
  constructor(fs, path, net, root) {
    this.fs = fs;
    this.path = path;
    this.net = net;
    this.root = root;
    this.accounts_path = path.join(root, "accounts.json");
    this.lock_path = path.join(root, "lock");
    this.sock_path = "subnet.sock";
    this.accounts = fs.existsSync(this.accounts_path) ? JSON.parse(fs.readFileSync(this.accounts_path, "utf8")) : {};
    this.clients = new Map();
    this.listening = false;
    this.room_names = new Map();
    this.member_names = new Map();
    this.room_networks = new Map();
    this.watchers = new Set();
  }

  save() {
    this.fs.writeFileSync(this.accounts_path, JSON.stringify(this.accounts, null, 2), { mode: 0o600 });
    this.fs.chmodSync(this.accounts_path, 0o600);
  }

  try_lock() {
    try {
      this.fs.writeFileSync(this.lock_path, String(process.pid), { flag: "wx" });
      process.on("exit", () => this.release_lock());
      return true;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
    }
    if (pid_alive(Number(this.fs.readFileSync(this.lock_path, "utf8")))) return false;
    this.fs.rmSync(this.lock_path, { force: true });
    return this.try_lock();
  }

  release_lock() {
    if (this.fs.existsSync(this.lock_path) && this.fs.readFileSync(this.lock_path, "utf8") === String(process.pid)) this.fs.rmSync(this.lock_path);
  }

  async acquire(argv) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const forwarded = argv ? await this.forward(argv) : null;
      if (forwarded) return forwarded;
      if (this.try_lock()) return null;
      await sleep(200);
    }
    throw new Error(`Another subnet process holds ${this.lock_path}`);
  }

  forward(argv) {
    return new Promise((resolve, reject) => {
      const socket = this.net.createConnection(this.sock_path);
      let data = "";
      socket.on("connect", () => socket.write(`${JSON.stringify({ argv })}\n`));
      socket.on("data", (chunk) => (data += chunk));
      socket.on("end", () => resolve(JSON.parse(data)));
      socket.on("error", (e) => (["ENOENT", "ECONNREFUSED"].includes(e.code) ? resolve(null) : reject(e)));
    });
  }

  serve() {
    this.fs.rmSync(this.sock_path, { force: true });
    this.net.createServer((socket) => this.on_socket(socket)).listen(this.sock_path, () => this.fs.chmodSync(this.sock_path, 0o600));
  }

  on_socket(socket) {
    let data = "";
    socket.on("data", async (chunk) => {
      data += chunk;
      if (!data.includes("\n")) return;
      const request = JSON.parse(data);
      if (request.watch) return this.add_watcher(socket, request.watch);
      socket.end(JSON.stringify(await this.execute(request.argv)));
    });
  }

  async add_watcher(socket, filter) {
    const resolved = { ...filter };
    for (const key of ["network", "room"]) if (filter[key]) resolved[key] = (await this.room_client(filter[key], filter.server)).room_id;
    const watcher = { socket, filter: resolved };
    this.watchers.add(watcher);
    socket.on("close", () => this.watchers.delete(watcher));
    socket.on("error", () => this.watchers.delete(watcher));
  }

  watched(filter, line) {
    if (filter.server && line.server !== normalize_homeserver(filter.server)) return false;
    if (filter.room && line.room_id !== filter.room) return false;
    return !filter.network || line.network_id === filter.network || line.room_id === filter.network;
  }

  async execute(argv) {
    try {
      return { stdout: `${JSON.stringify(await this.command(argv), null, 2)}\n`, stderr: "", code: 0 };
    } catch (e) {
      return { stdout: "", stderr: `${JSON.stringify({ error: e.message })}\n`, code: 1 };
    }
  }

  async close_all() {
    for (const client of this.clients.values()) await (await client).close();
    this.clients.clear();
  }

  account(server) {
    const accounts = Object.values(this.accounts);
    if (server) {
      const found = accounts.find((a) => a.homeserver === normalize_homeserver(server) || new URL(a.homeserver).host === server || a.user_id.endsWith(`:${server}`));
      if (!found) throw new Error(`No account for ${server}, run subnet login first`);
      return found;
    }
    if (accounts.length !== 1) throw new Error(accounts.length ? "Several accounts, pass --server" : "No account, run subnet login first");
    return accounts[0];
  }

  async room_account(room, server) {
    if (server) return this.account(server);
    if (room.startsWith("#")) return this.account(room.slice(room.indexOf(":") + 1));
    if (!this.room_holder(room)) for (const account of Object.values(this.accounts)) if (await this.reachable(account)) await this.refresh_rooms(account);
    return this.room_holder(room) ?? this.account();
  }

  room_holder(room) {
    return Object.values(this.accounts).find((a) => a.rooms.includes(room));
  }

  client(account) {
    if (!this.clients.has(account.homeserver)) this.clients.set(account.homeserver, this.connect(account).catch((e) => this.forget_client(account, e)));
    return this.clients.get(account.homeserver);
  }

  forget_client(account, error) {
    this.clients.delete(account.homeserver);
    throw error;
  }

  async reachable(account) {
    try {
      return await this.client(account);
    } catch (e) {
      this.warn(account, e);
      return null;
    }
  }

  warn(account, error) {
    process.stderr.write(`${JSON.stringify({ error: error.message, server: account.homeserver })}\n`);
  }

  async keep_connected(account) {
    for (let failures = 0; this.accounts[account.homeserver] === account && !(await this.reachable(account)); failures++) await sleep(BACKOFF_MS[Math.min(failures, BACKOFF_MS.length - 1)]);
  }

  store_name(homeserver) {
    return this.path.join(this.root, new URL(homeserver).host);
  }

  async connect(account) {
    const client = new MatrixClient({ homeserver: account.homeserver, username: account.username, password: account.password, store_name: this.store_name(account.homeserver), device_name: account.device_name });
    await client.login();
    if (this.listening) client.listen((batch) => this.on_batch(account, client, batch));
    return client;
  }

  async refresh_rooms(account) {
    account.rooms = await (await this.client(account)).joined_rooms();
    this.save();
  }

  async room_client(room, server) {
    const account = await this.room_account(room, server);
    const client = await this.client(account);
    return { account, client, room_id: await client.resolve(room) };
  }

  async names(client, room_id, senders) {
    if (!this.member_names.has(room_id) || senders.some((s) => !(s in this.member_names.get(room_id)))) {
      this.member_names.set(room_id, Object.fromEntries((await client.members(room_id)).map((m) => [m.user_id, m.display_name ?? localpart(m.user_id)])));
    }
    return this.member_names.get(room_id);
  }

  async room_name(client, room_id, events) {
    if (!this.room_names.has(room_id) || events.some((e) => e.type === "m.room.name")) this.room_names.set(room_id, await client.room_name(room_id));
    return this.room_names.get(room_id);
  }

  async network(client, room_id) {
    if (!this.room_networks.has(room_id)) this.room_networks.set(room_id, await client.network_of(room_id));
    const network_id = this.room_networks.get(room_id);
    return { network_id, network_name: network_id ? await this.room_name(client, network_id, []) : null };
  }

  async login(homeserver_arg, username, password, device_name) {
    const homeserver = normalize_homeserver(homeserver_arg);
    if (this.clients.has(homeserver)) await (await this.clients.get(homeserver)).close();
    this.clients.delete(homeserver);
    if (this.accounts[homeserver] && this.accounts[homeserver].username !== username) this.fs.rmSync(this.store_name(homeserver), { recursive: true, force: true });
    const account = { homeserver, username, password, device_name, user_id: null, device_id: null, rooms: [] };
    const client = await this.client(account);
    Object.assign(account, client.session(), { rooms: await client.joined_rooms() });
    this.accounts[homeserver] = account;
    this.save();
    return client.session();
  }

  async logout(server) {
    const account = this.account(server);
    delete this.accounts[account.homeserver];
    this.save();
    const client = await this.reachable(account);
    this.clients.delete(account.homeserver);
    if (client) await client.logout().catch((e) => this.warn(account, e));
    if (client) await client.close();
    this.fs.rmSync(this.store_name(account.homeserver), { recursive: true, force: true });
    return { logged_out: account.homeserver };
  }

  async rooms() {
    const out = [];
    for (const account of Object.values(this.accounts)) {
      const client = await this.reachable(account);
      if (!client) continue;
      await this.refresh_rooms(account);
      for (const room_id of account.rooms) out.push({ server: account.homeserver, room_id, name: await client.room_name(room_id), members: (await client.members(room_id)).filter((m) => m.membership === "join").length });
    }
    return out;
  }

  async channel_rows(client, network_id) {
    const out = [];
    for (const room_id of await client.channels(network_id)) out.push({ room_id, name: await client.room_name(room_id) });
    return out;
  }

  async networks(server) {
    const out = [];
    for (const account of server ? [this.account(server)] : Object.values(this.accounts)) {
      const client = await this.reachable(account);
      if (!client) continue;
      await this.refresh_rooms(account);
      for (const room_id of account.rooms) {
        if (await client.is_network(room_id)) out.push({ server: account.homeserver, room_id, name: await client.room_name(room_id), channels: await this.channel_rows(client, room_id) });
      }
    }
    return out;
  }

  async invites() {
    const out = [];
    for (const account of Object.values(this.accounts)) {
      const client = await this.reachable(account);
      if (client) for (const invite of await client.invites()) out.push({ server: account.homeserver, ...invite });
    }
    return out;
  }

  async read(client, room_id, limit, thread) {
    const { events } = thread ? await client.thread(room_id, thread, { limit }) : await client.messages(room_id, { limit });
    return project(events, client.user_id, await this.names(client, room_id, []));
  }

  async send_file(client, room_id, file_path, thread) {
    const name = this.path.basename(file_path);
    const mime = MIME_TYPES[name.split(".").pop().toLowerCase()] ?? "application/octet-stream";
    return { event_id: await client.send_file(room_id, new Uint8Array(this.fs.readFileSync(file_path)), { name, mime, thread_root: thread }) };
  }

  async download(client, room_id, event_id, out_path) {
    const [message] = project([await client.event(room_id, event_id)], client.user_id, {});
    if (!message?.attachment) throw new Error(`Event ${event_id} has no attachment`);
    const bytes = await client.download(message.attachment);
    this.fs.writeFileSync(out_path, bytes);
    return { path: out_path, size: bytes.length, name: message.attachment.name, mime: message.attachment.mime };
  }

  async command(argv) {
    const { args, flags } = parse_args(argv);
    const [name, a, b, c] = args;
    if (name === "login") return this.login(a, flags.user, flags.password, flags.name);
    if (name === "register") {
      const password = flags.password ?? c;
      await register(normalize_homeserver(a), b, password, flags.token);
      return this.login(a, b, password, flags.name);
    }
    if (name === "accounts") return Object.values(this.accounts).map(({ password, ...account }) => account);
    if (name === "logout") return this.logout(flags.server);
    if (name === "whoami") return flags.server || Object.keys(this.accounts).length === 1 ? (await this.client(this.account(flags.server))).session() : Promise.all(Object.values(this.accounts).map(async (account) => (await this.client(account)).session()));
    if (name === "rooms") return this.rooms();
    if (name === "invites") return this.invites();
    if (name === "create-room") {
      const account = this.account(flags.server);
      const power_users = flags.power ? Object.fromEntries(flags.power.split(",").map((pair) => [pair.slice(0, pair.lastIndexOf("=")), Number(pair.slice(pair.lastIndexOf("=") + 1))])) : undefined;
      const room_id = await (await this.client(account)).create_room({ name: flags.name, alias: flags.alias, invite: flags.invite?.split(","), power_users });
      await this.refresh_rooms(account);
      return { room_id };
    }
    if (name === "create-network") {
      const account = this.account(flags.server);
      const network = await (await this.client(account)).create_network({ name: flags.name, alias: flags.alias });
      await this.refresh_rooms(account);
      return { ...network, alias: flags.alias ? `#${flags.alias}:${server_name(account.user_id)}` : null };
    }
    if (name === "networks") return this.networks(flags.server);
    if (name === "join") {
      const account = await this.room_account(a, flags.server);
      const client = await this.client(account);
      const room_id = await client.join(a);
      const channels = (await client.is_network(room_id)) ? (await client.join_network(room_id)).channels : [];
      await this.refresh_rooms(account);
      return { room_id, channels };
    }
    if (["channels", "create-channel", "remove-channel"].includes(name)) {
      const { account, client, room_id } = await this.room_client(a, flags.server);
      if (name === "channels") return this.channel_rows(client, room_id);
      if (name === "remove-channel") return client.remove_channel(room_id, b).then(() => ({ network: room_id, removed: b }));
      const channel = await client.create_channel(room_id, flags.name);
      await this.refresh_rooms(account);
      return { network: room_id, room_id: channel };
    }
    if (name === "set-displayname") {
      for (const account of flags.server ? [this.account(flags.server)] : Object.values(this.accounts)) await (await this.client(account)).set_displayname(a);
      return { displayname: a };
    }
    if (!ROOM_COMMANDS.includes(name)) throw new Error(`Unknown command ${name}\n${USAGE}`);
    const { account, client, room_id } = await this.room_client(a, flags.server);
    if (name === "read") return this.read(client, room_id, Number(flags.limit ?? 30), flags.thread);
    if (name === "send-file") return this.send_file(client, room_id, b, flags.thread);
    if (name === "download") return this.download(client, room_id, b, c);
    if (name === "leave") {
      await client.leave(room_id);
      await this.refresh_rooms(account);
      return { room_id, left: true };
    }
    if (name === "invite") return client.invite(room_id, b).then(() => ({ room_id, invited: b }));
    if (name === "kick") return client.kick(room_id, b, flags.reason).then(() => ({ room_id, kicked: b }));
    if (name === "members") return (await client.members(room_id)).filter((m) => m.membership === "join" || m.membership === "invite");
    if (name === "send") return { event_id: await client.send(room_id, b, { reply_to: flags["reply-to"], thread_root: flags.thread }) };
    if (name === "edit") return { event_id: await client.edit(room_id, b, c) };
    if (name === "react") return { event_id: await client.react(room_id, b, c) };
    if (name === "redact") return { event_id: await client.redact(room_id, b, flags.reason) };
    if (name === "receipt") return client.read_receipt(room_id, b).then(() => ({ room_id, read: b }));
    return client.typing(room_id, b === "on").then(() => ({ room_id, typing: b === "on" }));
  }

  watch(filter) {
    const socket = this.net.createConnection(this.sock_path);
    socket.on("connect", () => socket.write(`${JSON.stringify({ watch: filter })}\n`));
    socket.on("data", (chunk) => process.stdout.write(chunk));
    socket.on("close", () => process.exit(1));
    socket.on("error", (e) => {
      process.stderr.write(`${JSON.stringify({ error: `subnet listen is not running: ${e.message}` })}\n`);
      process.exit(1);
    });
  }

  async listen() {
    await this.acquire(null);
    this.listening = true;
    this.serve();
    for (const account of Object.values(this.accounts)) this.keep_connected(account);
    process.on("SIGTERM", () => this.shutdown());
    process.on("SIGINT", () => this.shutdown());
  }

  async shutdown() {
    await this.close_all();
    this.fs.rmSync(this.sock_path, { force: true });
    process.exit(0);
  }

  emit(line) {
    const text = `${JSON.stringify(line)}\n`;
    process.stdout.write(text);
    for (const { socket, filter } of this.watchers) if (this.watched(filter, line)) socket.write(text);
  }

  async on_batch(account, client, batch) {
    for (const invite of batch.invites) this.emit({ type: "invite", server: account.homeserver, ...invite });
    for (const [room_id, { events }] of Object.entries(batch.rooms)) await this.emit_room(account, client, room_id, events);
    if (batch.left.length || Object.keys(batch.rooms).some((room_id) => !account.rooms.includes(room_id))) await this.refresh_rooms(account);
  }

  async emit_room(account, client, room_id, events) {
    const others = events.filter((e) => e.sender && e.sender !== client.user_id);
    if (!others.some((e) => ["m.room.message", "m.room.encrypted", "m.reaction"].includes(e.type))) return;
    const names = await this.names(client, room_id, others.map((e) => e.sender));
    const base = { server: account.homeserver, room_id, room_name: await this.room_name(client, room_id, events), ...(await this.network(client, room_id)) };
    for (const message of project(others, client.user_id, names)) this.emit({ type: "message", ...base, message });
    for (const e of others) {
      const relation = e.content["m.relates_to"];
      if (e.type === "m.room.message" && relation?.rel_type === "m.replace") this.emit({ type: "edit", ...base, event_id: relation.event_id, sender: e.sender, sender_name: names[e.sender], body: e.content["m.new_content"]?.body ?? e.content.body, encrypted: !!e.encrypted, verified: !!e.verified });
      if (e.type === "m.reaction" && relation?.rel_type === "m.annotation") this.emit({ type: "reaction", ...base, event_id: relation.event_id, sender: e.sender, sender_name: names[e.sender], key: relation.key });
    }
  }
}

function absolute_argv(fs, path, argv) {
  const { args, flags } = parse_args(argv);
  const out = [...argv];
  if (args[0] === "send" && args[2] === "-") out[out.indexOf("-")] = fs.readFileSync(0, "utf8");
  if (["login", "register"].includes(args[0]) && flags.password === "-") out[out.indexOf("--password") + 1] = fs.readFileSync(0, "utf8").replace(/\r?\n$/, "");
  if (args[0] === "send-file") out[out.indexOf(args[2])] = path.resolve(args[2]);
  if (args[0] === "download") out[out.indexOf(args[3])] = path.resolve(args[3]);
  return out;
}

async function cli(argv) {
  if (argv[0] === "--version") return console.log(JSON.stringify({ version: VERSION }));
  const [fs, path, os, net] = ["node:fs", "node:path", "node:os", "node:net"].map(node_module);
  const root = path.resolve(process.env.SUBNET_CLIENT_STATE_PATH ?? path.join(os.homedir(), ".subnet-client-state"));
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const full_argv = absolute_argv(fs, path, argv);
  process.chdir(root);
  const ctx = new Cli(fs, path, net, root);
  if (argv[0] === "listen") return ctx.listen();
  if (argv[0] === "watch") return ctx.watch(parse_args(argv).flags);
  const result = (await ctx.acquire(full_argv)) ?? (await ctx.execute(full_argv));
  await ctx.close_all();
  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr ?? "");
  process.exit(result.code);
}

function is_main() {
  return import.meta.url === node_module("node:url").pathToFileURL(node_module("node:fs").realpathSync(process.argv[1])).href;
}

if (IS_NODE && process.argv[1] && is_main()) {
  cli(process.argv.slice(2)).catch((e) => {
    process.stderr.write(`${JSON.stringify({ error: e.message })}\n`);
    process.exit(1);
  });
}
