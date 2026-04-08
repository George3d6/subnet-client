# Matrix Library Reference

Reference documentation for the Matrix-related libraries and APIs that `subnet-client` actually uses. Compiled from the latest upstream sources as of 2026-04-08.

What this project actually depends on:

| Surface | Where it's used | Notes |
|---|---|---|
| `@matrix-org/matrix-sdk-crypto-nodejs` v0.4.0 | `lib/matrix_e2e.js` | Native Rust `OlmMachine` for E2EE. |
| Matrix Client-Server API v1.18 (raw HTTP) | `lib/matrix_e2e.js` | Called directly via `fetch`. No JS SDK. |
| Olm / Megolm protocols | (transitively, via OlmMachine) | Background protocol context. |

`matrix-js-sdk` and `fake-indexeddb` are listed in `package.json` but **not actually imported** anywhere in `lib/`. They are removable cruft.

---

## A. `@matrix-org/matrix-sdk-crypto-nodejs`

### Status & latest version

- **Latest version:** `0.4.0`, published 2026-01-08. The `^0.4.0` pin in `package.json` is already on the current latest — no upgrade available in the 0.4.x line.
- **Maintenance:** Not formally deprecated. The npm metadata has no `deprecated` field and the README carries no archive/EOL notice. The repo at <https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs> still receives releases.
- **Scope:** Per the v0.1.0-beta.0 changelog entry, the package self-describes as scoped to "what's required to build Matrix bots or Matrix bridges". Treat it as **maintained but slow-moving, bot/bridge focused**.
- **Successor (forward-looking):** `@matrix-org/matrix-sdk-crypto-wasm` is the strategically favoured E2EE binding for JS/TS. See section B. *Not migrating now.*
- **Underlying engine:** Vodozemac (Rust). The deprecated C reference library `libolm` is no longer used.

### Lifecycle (push / pull state machine)

Verbatim from the package README:

> The `OlmMachine` state machine works in a push/pull manner:
> - You push state changes and events retrieved from a Matrix homeserver `/sync` response, into the state machine,
> - You pull requests that you will need to send back to the homeserver out of the state machine.

The practical loop `lib/matrix_e2e.js` implements:

1. **Push** — on every `/sync` response, call `receiveSyncChanges(toDeviceEvents, changedDevices, oneTimeKeyCounts, unusedFallbackKeys)`. The machine decrypts incoming to-device events and updates its internal state.
2. **Pull** — call `outgoingRequests()`. You get an array of typed requests (`KeysUploadRequest`, `KeysQueryRequest`, `KeysClaimRequest`, `ToDeviceRequest`, `SignatureUploadRequest`, `RoomMessageRequest`).
3. **Dispatch + ack** — send each request to the matching CS-API endpoint, then feed the response body (as a JSON string) back via `markRequestAsSent(requestId, requestType, responseBodyJson)`.
4. **Per-room key sharing** — before encrypting in a room for the first time after a membership/device change, call `updateTrackedUsers(users)` then `shareRoomKey(roomId, users, encryptionSettings)`. The returned `ToDeviceRequest[]` must be sent and acked **before** the first `encryptRoomEvent`.
5. **Encrypt / decrypt** — `encryptRoomEvent(roomId, eventType, contentJson)` returns the ciphertext to put in `m.room.encrypted`. `decryptRoomEvent(eventJson, roomId)` returns a `DecryptedRoomEvent`.
6. **Shutdown** — `close()` releases the crypto store. The machine cannot be used afterwards (will panic per the Rust docstring).

Per the `getMissingSessions` docstring, take care that only one outgoing-request cycle is in flight at a time (use a mutex / queue if you parallelize).

### `OlmMachine` API (only the methods we use)

All signatures verbatim from `node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.d.ts` (v0.4.0). Online docs: <https://matrix-org.github.io/matrix-rust-sdk-crypto-nodejs/>.

```ts
static initialize(
  userId: UserId,
  deviceId: DeviceId,
  storePath?: string | undefined | null,
  storePassphrase?: string | undefined | null,
  storeType?: StoreType | undefined | null,
): Promise<OlmMachine>
```
Constructs the machine asynchronously. If `storePath` is omitted the keys live in memory only and are lost on `close()` / process exit. If `storePath` is set, `storePassphrase` encrypts data at rest — **omitting it leaves the store unencrypted**. `storeType` currently only supports `StoreType.Sqlite`.

```ts
receiveSyncChanges(
  toDeviceEvents: string,                   // JSON-encoded array of to-device events
  changedDevices: DeviceLists,              // from /sync device_lists
  oneTimeKeyCounts: Record<string, number>, // from /sync device_one_time_keys_count
  unusedFallbackKeys: Array<string>,        // from /sync device_unused_fallback_key_types
): Promise<string>
```
Returns the decrypted to-device events as a JSON-encoded string. Must be called for every `/sync` response so the machine can process Olm messages, key requests, and device-list churn.

```ts
outgoingRequests(): Promise<Array<
  KeysUploadRequest | KeysQueryRequest | KeysClaimRequest |
  ToDeviceRequest   | SignatureUploadRequest | RoomMessageRequest
>>
```
Returns queued requests the machine needs the client to POST/PUT to the homeserver. Each element carries a `readonly id` and a `readonly body` (JSON string to use as the HTTP body).

```ts
markRequestAsSent(
  requestId: string,
  requestType: RequestType,
  response: string,        // raw JSON response body from the homeserver
): Promise<boolean>
```
Couples the HTTP response back into the state machine. Must be called after every successful request returned by `outgoingRequests()`.

```ts
updateTrackedUsers(users: Array<UserId>): Promise<void>
```
Marks users for device-list tracking / key query. No-ops for users already tracked.

```ts
shareRoomKey(
  roomId: RoomId,
  users: Array<UserId>,
  encryptionSettings: EncryptionSettings,
): Promise<Array<ToDeviceRequest>>
```
Generates (or reuses) the outbound Megolm group session for `roomId` and returns the `ToDeviceRequest`s needed to distribute it to the listed users' devices. Each returned request **must** be sent and `markRequestAsSent`-ed before the first `encryptRoomEvent`.

```ts
encryptRoomEvent(
  roomId: RoomId,
  eventType: string,       // plaintext event type, e.g. "m.room.message"
  content: string,         // JSON-encoded content
): Promise<string>
```
Returns a JSON string to put into `m.room.encrypted` via `PUT /rooms/{roomId}/send/m.room.encrypted/{txnId}`.

```ts
decryptRoomEvent(event: string, roomId: RoomId): Promise<DecryptedRoomEvent>
```
Decrypts a `m.room.encrypted` timeline event. `event` is the raw JSON of the full event. `DecryptedRoomEvent` carries the plaintext, sender info, and shield state.

```ts
close(): void
```
Shuts down the machine and closes the crypto store. The instance **must not** be touched after this — the Rust side will panic.

### Helper types we use

- **`UserId`** — `new UserId(id: string)`. Has `get localpart`, `get serverName`, `isHistorical()`, `toString()`.
- **`DeviceId`** — `new DeviceId(id: string)`; `toString()`. Matrix device IDs are opaque strings.
- **`RoomId`** — `new RoomId(id: string)`; `toString()`. **Breaking in v0.4.0-beta.1:** `serverName` was removed; `RoomId` may no longer have a server-name component.
- **`RequestType`** — `const enum`: `KeysUpload = 0`, `KeysQuery = 1`, `KeysClaim = 2`, `ToDevice = 3`, `SignatureUpload = 4`, `RoomMessage = 5`, `KeysBackup = 6`. Used as the second argument to `markRequestAsSent`.
- **`KeysUploadRequest`** — `{ readonly id: string; readonly body: string; get type: RequestType }`. `body` is a JSON string with `device_keys`, `one_time_keys`, `fallback_keys` — ready to POST to `/_matrix/client/v3/keys/upload`.
- **`KeysQueryRequest`** — same shape; `body` is `{"timeout":…,"device_keys":…}`, for `/_matrix/client/v3/keys/query`.
- **`KeysClaimRequest`** — same shape; `body` is `{"timeout":…,"one_time_keys":…}`, for `/_matrix/client/v3/keys/claim`.
- **`ToDeviceRequest`** — `{ readonly id; readonly eventType: string; readonly txnId: string; readonly body: string; get type }`. `body` contains the `messages` field for `PUT /_matrix/client/v3/sendToDevice/{eventType}/{txnId}`.
- **`EncryptionSettings`** — constructor takes no args; fields: `algorithm: EncryptionAlgorithm`, `rotationPeriod: bigint` (microseconds), `rotationPeriodMessages: bigint`, `historyVisibility: HistoryVisibility`, `onlyAllowTrustedDevices: boolean`, `errorOnVerifiedUserProblem: boolean`.
- **`HistoryVisibility`** — `const enum`: `Invited = 0`, `Joined = 1`, `Shared = 2`, `WorldReadable = 3`. Must match the room's `m.room.history_visibility` state to share keys correctly.
- **`EncryptionAlgorithm`** — `const enum`: `OlmV1Curve25519AesSha2 = 0` (used for 1:1 Olm sessions), `MegolmV1AesSha2 = 1` (used for room encryption). Megolm is what you want in `EncryptionSettings.algorithm`.

### Notable changes since v0.4.0

None — v0.4.0 is the current stable. The UNRELEASED section of the upstream `CHANGELOG.md` is empty.

For context on what changed *getting to* v0.4.0:

- **v0.4.0 (2026-01-08)** — Fixes malformed request formatting for `/keys/upload`, `/keys/query` and `/keys/claim`. This is the reason the stable was cut; if you were on `0.4.0-beta.1` you want the fix.
- **v0.4.0-beta.1 (2025-08-11)** — Breaking:
  - `RoomId.serverName` removed; `RoomId` may lack a server-name component.
  - Dropped Node 18 and 20; **requires Node 22 or 24** (NAPI v6).
  - Minimum glibc bumped to 2.35 (Ubuntu 22.04+).
  - Bumps the underlying `matrix-rust-sdk` to 0.9.0; drops `SignedCurve25519`.

⚠️ The Node-22 minimum conflicts with the `"engines": { "node": ">=18.0.0" }` declared in `package.json`. Either bump the engines field or stop relying on transitive Node 18 compatibility.

---

## B. `@matrix-org/matrix-sdk-crypto-wasm` (forward-looking successor)

### Status

- **Latest version:** `18.0.0` (March 2026). Aggressive release cadence — regular major version bumps.
- **npm:** <https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm>
- **GitHub:** <https://github.com/matrix-org/matrix-sdk-crypto-wasm>
- **Official successor?** *Unverified as an explicit declaration.* Neither README says "this replaces the nodejs binding". The conclusion is circumstantial: `matrix-js-sdk` (the canonical JavaScript Matrix client) uses `matrix-sdk-crypto-wasm` for its E2EE layer, the package is the active upstream focus, and the nodejs binding self-describes a narrower bot/bridge scope.

### Migration notes (when we eventually move)

- **Async init is mandatory.** You must `await initAsync()` before any other call. No equivalent in the nodejs binding.
- **Dual entry points.** Separate bundles for Node.js (loads the `.wasm` via `fs.readFile`) and browser (via `fetch`). The correct one is selected automatically based on the runtime.
- **Store backends.** Default is in-memory; the package recommends IndexedDB **where available** (i.e. browsers). There is **no built-in SQLite store** as in the nodejs binding — this is the biggest ergonomic difference for a persistent Node server. You will need to design your persistence strategy accordingly.
- **Same OlmMachine concept.** Method names and the push/pull model are the same (`initialize`, `receiveSyncChanges`, `outgoingRequests`, `markRequestAsSent`, `shareRoomKey`, `encryptRoomEvent`, `decryptRoomEvent`). Argument shapes may drift between major versions; re-check the current `.d.ts` at migration time.
- **Node version requirements.** Not explicitly stated in the README. Assume modern LTS.
- **No Rust toolchain at install time.** The `.wasm` is shipped in the tarball, so you avoid the prebuilt-binary download dance and glibc version headaches.
- **Versioning is SemVer-real.** Unlike the nodejs binding's slow `0.x` line, expect breaking changes on every major upgrade.

---

## C. Matrix Client-Server API (v1.18)

Latest stable spec: **v1.18**, at <https://spec.matrix.org/v1.18/client-server-api/> (also reachable via <https://spec.matrix.org/latest/client-server-api/>). All section links below resolve against the v1.18 document.

All requests except `POST /login` and `GET /publicRooms` require an `Authorization: Bearer <access_token>` header.

### Endpoint reference

#### `POST /_matrix/client/v3/login`
Authenticate a user and obtain an access token + device ID. No prior auth required.

Request body (fields we care about):
```json
{
  "type": "m.login.password",
  "identifier": { "type": "m.id.user", "user": "<localpart or full mxid>" },
  "password": "...",
  "device_id": "<optional; reuse existing>",
  "initial_device_display_name": "<optional>"
}
```
Response (200): `user_id`, `access_token`, `device_id`, `home_server` (deprecated but still returned), optionally `well_known`, `expires_in_ms`, `refresh_token`. Rate-limited.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3login>

#### `GET /_matrix/client/v3/account/whoami`
Validates the current access token and returns identity information.

Response (200): `user_id`, `device_id`, `is_guest`. Errors: `M_UNKNOWN_TOKEN` / `M_MISSING_TOKEN`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3accountwhoami>

#### `GET /_matrix/client/v3/publicRooms`
Lists public rooms in the server's directory. No auth required (configurable server-side).

Query: `limit` (int, optional), `since` (pagination token, optional), `server` (federated directory, optional).

Response (200): `chunk: PublicRoomsChunk[]` (each entry has `room_id`, `name`, `topic`, `num_joined_members`, `canonical_alias`, `world_readable`, `guest_can_join`, `join_rule`, `avatar_url`, `room_type`), `next_batch`, `prev_batch`, `total_room_count_estimate`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3publicrooms>

#### `GET /_matrix/client/v3/joined_rooms`
Returns room IDs the authenticated user has joined.

Response (200): `{ "joined_rooms": ["!id:server", ...] }`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3joined_rooms>

#### `POST /_matrix/client/v3/join/{roomIdOrAlias}`
Joins a room by ID or canonical alias.

Query: `server_name` (optional, array; hint for federation when the room isn't local).
Body: `{ "reason": "...", "third_party_signed": {...} }` — both optional; empty `{}` is fine.
Response (200): `{ "room_id": "!id:server" }`. Rate-limited.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3joinroomidoralias>

#### `GET /_matrix/client/v3/rooms/{roomId}/messages`
Paginated historical messages. See the dedicated pagination section below.

Query: `dir` (`b` = backwards, `f` = forwards), `from` (token, required), `to` (token, optional), `limit` (int, default per spec is **10**), `filter` (JSON-encoded `RoomEventFilter`).

Response (200): `chunk: ClientEvent[]`, `start: string`, `end: string`, optional `state: ClientEvent[]`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3roomsroomidmessages>

#### `PUT /_matrix/client/v3/rooms/{roomId}/send/{eventType}/{txnId}`
Send a message event to a room. For E2EE, `eventType` is `m.room.encrypted` and the body is whatever `OlmMachine.encryptRoomEvent` returned.

Body: arbitrary event `content` (JSON object).
Response (200): `{ "event_id": "$..." }`.

`txnId`: client-generated, unique per (device, HTTP endpoint). On retransmission with the same `txnId`, the server returns the original response — safe retries, no duplicate events. It is **not** global: reusing a txnId on a different endpoint or device is allowed.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#put_matrixclientv3roomsroomidsendeventtypetxnid>

#### `GET /_matrix/client/v3/sync`
The firehose. Drives the OlmMachine push phase.

Query: `since` (token from previous response; omit for initial sync), `timeout` (ms to long-poll), `filter` (ID or inline JSON `Filter`), `full_state` (bool), `set_presence` (`online|offline|unavailable`).

Response (200) — fields we consume:

- `next_batch` — token for the next call.
- `rooms.{join,invite,leave}` — per-room timeline, state, ephemeral, account_data, summary, unread counts.
- `to_device.events` — to-device events to push into `receiveSyncChanges`.
- `device_lists.{changed,left}` — also pushed into `receiveSyncChanges`.
- `device_one_time_keys_count` — one-time key counts by algorithm; passed to `receiveSyncChanges`.
- `device_unused_fallback_key_types` — fallback key types; passed to `receiveSyncChanges`.

Long-polling endpoint: set `timeout` to ~30000 ms and re-issue with the returned `next_batch`. Initial sync (no `since`) can be very large — consider a narrowing `filter`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3sync>

#### `POST /_matrix/client/v3/keys/upload`
Publish this device's identity + one-time + fallback keys.

Body: `{ "device_keys": {...}, "one_time_keys": {...}, "fallback_keys": {...} }` — all optional individually. For E2EE via OlmMachine you just PUT the `body` field of a `KeysUploadRequest` verbatim.
Response (200): `{ "one_time_key_counts": { "<algorithm>": <int>, ... } }`. Feed this response body straight into `markRequestAsSent`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3keysupload>

#### `POST /_matrix/client/v3/keys/query`
Fetch identity and device keys for a set of users.

Body: `{ "timeout": <ms>, "device_keys": { "<user_id>": ["<device_id>", ...] } }` — empty array means "all devices for that user".
Response (200): `device_keys` (per-user, per-device key data), `master_keys`, `self_signing_keys`, `user_signing_keys`, `failures` (per-server).

Spec: <https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3keysquery>

#### `POST /_matrix/client/v3/keys/claim`
Claim one-time keys from other users' devices so an Olm session can be established (needed before `shareRoomKey` to new devices).

Body: `{ "timeout": <ms>, "one_time_keys": { "<user_id>": { "<device_id>": "<algorithm>" } } }`.
Response (200): `{ "one_time_keys": { "<user_id>": { "<device_id>": { "<algo>:<key_id>": <key_object> } } }, "failures": {...} }`.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3keysclaim>

#### `PUT /_matrix/client/v3/sendToDevice/{eventType}/{txnId}`
Send events directly to devices, bypassing rooms. Used heavily by E2EE for room-key distribution (Olm-wrapped `m.room.encrypted` payloads) and key-sharing protocols.

Body: `{ "messages": { "<user_id>": { "<device_id | \"*\">": <content> } } }`.
Response (200): `{}` — empty body. Still must be fed to `markRequestAsSent`. `txnId` has the same idempotency semantics as the room-send endpoint.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#put_matrixclientv3sendtodeviceeventtypetxnid>

#### `POST /_matrix/client/v3/keys/signatures/upload`
Publish cross-signing signatures over device keys and user identities. Emitted by `OlmMachine` as `SignatureUploadRequest` during verification / bootstrap flows.

Body: `{ "<user_id>": { "<device_id | key_id>": <signed_key_object> } }`.
Response (200): `{ "failures": { "<user_id>": { "<key_id>": { "errcode": "...", "error": "..." } } } }` — empty `failures` means success.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#post_matrixclientv3keyssignaturesupload>

#### `GET /_matrix/client/v3/rooms/{roomId}/members`
Lists members of a room. Used by the OlmMachine integration to know who to share room keys with.

Query: `at` (sync token; pins the listing to a historical point), `membership` (`join|invite|knock|leave|ban`), `not_membership` (exclude one of those).
Response (200): `{ "chunk": ClientEvent[] }` where each event is an `m.room.member` state event. Use `event.state_key` as the user ID and `event.content.membership` for the membership.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3roomsroomidmembers>

#### `GET /_matrix/client/v3/rooms/{roomId}/state/m.room.encryption`
Returns the room's encryption state-event content. Used to detect whether a room is E2EE-enabled and what settings to feed into `EncryptionSettings`.

Response (200): the raw content object:
```json
{
  "algorithm": "m.megolm.v1.aes-sha2",
  "rotation_period_ms": 604800000,
  "rotation_period_msgs": 100
}
```
Returns **404 `M_NOT_FOUND`** for non-encrypted rooms (treat that as "plaintext room").

Spec: <https://spec.matrix.org/v1.18/client-server-api/#get_matrixclientv3roomsroomidstateeventtypestatekey> (generic state endpoint).

### `/messages` pagination model

The `/rooms/{roomId}/messages` tokens are **opaque strings** — do not parse them.

- `dir=b` (default in our client) — walk **backwards in time**. This is what you want when backfilling history.
- `dir=f` — walk forwards in time. Normally you get new events via `/sync`; `dir=f` is mostly used when you already have a historical token and want to walk toward the present.
- `from` — **required**. The pagination token to start from. For `dir=b`, typically an `end` token from a previous `/sync` (a room timeline's `prev_batch`) or the `end` of a previous `/messages` response.
- `to` — optional. Stop when this token is hit. Rarely used in practice.
- `limit` — max events to return. Default **10** per spec; the server is allowed to cap it lower. Always expect fewer events than you asked for.
- `filter` — JSON-encoded `RoomEventFilter` to narrow the returned events (e.g. `{"types":["m.room.message"]}`).

Response tokens:

- `start` — token for the **first** event returned (echoes your `from`).
- `end` — token **past the last** returned event. To paginate further in the same direction, pass `end` as the next call's `from`. If there are no more events in the requested direction, `end` may be absent.
- `chunk` — the events themselves, ordered per the requested `dir`. For `dir=b` this is newest-to-oldest.
- `state` — (optional) state events relevant to interpreting the chunk (e.g. membership state of senders at the time).

Our `readMessages` implementation walks `dir=b`, reverses the chunk into chronological order, and paginates to exhaustion by default. Pagination stops early when `sinceMinsAgo` is set and `oldest.origin_server_ts < cutoff`, when `limit` is set and enough text-bearing events have been collected, or when an internal hard safety bound (~5000 events) is hit to prevent runaway memory use.

### Rate limiting

Most state-changing endpoints (`/login`, `/join`, `/send`, `/sendToDevice`, `/keys/*`) are rate-limited. On throttling the server returns **HTTP 429** with JSON body:

```json
{ "errcode": "M_LIMIT_EXCEEDED", "error": "...", "retry_after_ms": 2000 }
```

A `Retry-After` header may also be set. Read endpoints (`/sync`, `/whoami`, `/joined_rooms`, `/messages`, `/rooms/{id}/members`, `/rooms/{id}/state/*`) are typically not rate-limited per the spec's `Rate-limited: No` markers, but homeservers are free to apply their own limits.

`E2EMatrixClient._fetch` handles 429 responses by sleeping for the longer of `Retry-After` (header) and `retry_after_ms` (body), then retrying.

Spec: <https://spec.matrix.org/v1.18/client-server-api/#rate-limiting>

---

## D. Olm & Megolm

### Olm

Olm is a Double-Ratchet–derived cryptographic ratchet (Signal-family) used in Matrix for **pairwise, 1:1 encrypted channels between individual devices**. In practice Olm is not used to encrypt room events directly — it is used to encrypt **to-device** messages, most importantly the distribution of Megolm group-session keys (the `m.room_key` / `m.forwarded_room_key` flow).

Historical note: the C reference library **libolm** was officially deprecated in **July 2024**. The recommended implementation is now **vodozemac** (Rust), which is what backs `matrix-sdk-crypto-nodejs` and `matrix-sdk-crypto-wasm`. The protocol is unchanged; only the implementation guidance shifted.

- Spec: <https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/olm.md>
- Explainer: <https://matrix.org/docs/matrix-concepts/end-to-end-encryption/>

### Megolm

Megolm is the AES-256-CTR + HMAC-SHA-256 group ratchet used for **room event encryption**. A sender creates one **outbound session** per room and derives a per-message key from a forward-secure ratchet; recipients each receive a matching **inbound session** (delivered via Olm-encrypted to-device messages). This gives O(1) encryption cost per message regardless of room size, forward secrecy against compromise of future ratchet state, and the ability to share "the current state of the Megolm key" with a newly-joining user — so they can read new messages but not historical ones (unless explicitly given an earlier ratchet index).

Rotation is driven by `rotation_period_ms` / `rotation_period_msgs` in `m.room.encryption`. The on-the-wire event format is `m.megolm.v1.aes-sha2`.

- Spec: <https://gitlab.matrix.org/matrix-org/olm/-/blob/master/docs/megolm.md>

---

## Sources

Authoritative for OlmMachine signatures:

- `node_modules/@matrix-org/matrix-sdk-crypto-nodejs/index.d.ts` (v0.4.0, NAPI-RS generated — exactly matches what runs at runtime)
- `node_modules/@matrix-org/matrix-sdk-crypto-nodejs/README.md`
- `node_modules/@matrix-org/matrix-sdk-crypto-nodejs/CHANGELOG.md`

Online:

- npm: <https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-nodejs>
- GitHub: <https://github.com/matrix-org/matrix-rust-sdk-crypto-nodejs>
- TypeDoc: <https://matrix-org.github.io/matrix-rust-sdk-crypto-nodejs/>
- npm (wasm successor): <https://www.npmjs.com/package/@matrix-org/matrix-sdk-crypto-wasm>
- GitHub (wasm successor): <https://github.com/matrix-org/matrix-sdk-crypto-wasm>
- matrix-js-sdk reference: <https://github.com/matrix-org/matrix-js-sdk>
- Matrix CS API spec (latest): <https://spec.matrix.org/latest/client-server-api/>
- Matrix CS API spec (v1.18 pinned): <https://spec.matrix.org/v1.18/client-server-api/>
- Olm/Megolm canonical specs: <https://gitlab.matrix.org/matrix-org/olm>
- E2EE explainer: <https://matrix.org/docs/matrix-concepts/end-to-end-encryption/>

### Caveats flagged inline as "unverified"

1. No explicit upstream statement declares `matrix-sdk-crypto-wasm` the official successor to `matrix-sdk-crypto-nodejs`. The conclusion is circumstantial (matrix-js-sdk uses it, release cadence, the nodejs binding's self-described bot/bridge scope).
2. `matrix-sdk-crypto-wasm`'s minimum Node.js version is not documented in its README.
3. The `/messages` default `limit` of 10 is the spec default; individual homeservers may cap it lower.
