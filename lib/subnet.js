const path = require('path');
const os = require('os');
const { ethers } = require('ethers');
const { E2EMatrixClient } = require('./matrix_e2e');

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.subnet-client-state');

/**
 * Derive the default EIP-191 sign message from the subnet API base URL.
 * This matches the subnet's own default of `{DOMAIN}-matrix-auth`.
 * Subnets that override SIGN_MESSAGE in their config require the caller to
 * pass `signMessage` explicitly (or set SUBNET_SIGN_MESSAGE).
 */
function deriveSignMessage(apiBase) {
  try {
    const host = new URL(apiBase).hostname;
    return `${host}-matrix-auth`;
  } catch {
    return null;
  }
}

class SubnetClient {
  /**
   * @param {object} opts
   * @param {string} opts.privateKey - Ethereum private key (hex)
   * @param {string} opts.apiBase - Subnet API base URL (e.g. "https://subnet.example.com")
   * @param {string} [opts.signMessage] - EIP-191 sign message used for auth.
   *   Defaults to `<host>-matrix-auth` derived from apiBase. Override only if
   *   the subnet uses a custom SIGN_MESSAGE in its config.
   */
  constructor({ privateKey, apiBase, signMessage }) {
    if (!apiBase) throw new Error('apiBase is required');
    this.apiBase = apiBase.replace(/\/$/, '');
    this.privateKey = privateKey;
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
    this.signMessage = signMessage || deriveSignMessage(this.apiBase);
    if (!this.signMessage) throw new Error('Could not derive signMessage from apiBase — pass it explicitly');
    this.credentials = null;
    this.matrix = null;
  }

  async _apiFetch(path, opts = {}) {
    const url = `${this.apiBase}${path}`;
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    const res = await fetch(url, { ...opts, headers });
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || `API error ${res.status}`);
    return data;
  }

  /**
   * Sign the subnet's auth message with the wallet.
   * @returns {Promise<string>} The EIP-191 signature
   */
  async _sign() {
    return this.wallet.signMessage(this.signMessage);
  }

  // --- Subnet API ---

  /**
   * Join the subnet using an invite code.
   * Registers the address and returns Matrix credentials.
   *
   * @param {string} inviteCode - The invite code
   * @returns {Promise<{address, matrix_username, matrix_password, matrix_url}>}
   */
  async join(inviteCode) {
    const signature = await this._sign();
    const data = await this._apiFetch('/api/join', {
      method: 'POST',
      body: JSON.stringify({
        code: inviteCode,
        address: this.address,
        signature
      })
    });
    this.credentials = data;
    return data;
  }

  /**
   * Retrieve Matrix credentials for an already-registered address.
   * @returns {Promise<{address, matrix_username, matrix_password, matrix_url}>}
   */
  async getCredentials() {
    const signature = await this._sign();
    const data = await this._apiFetch('/api/credentials', {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature
      })
    });
    this.credentials = data;
    return data;
  }

  /**
   * Fetch the current user's metadata, ABLT balance, and address from the subnet.
   * @returns {Promise<{address: string, metadata: string, ablt: number}>}
   */
  async getMetadata() {
    const signature = await this._sign();
    return this._apiFetch('/api/me', {
      method: 'POST',
      body: JSON.stringify({ address: this.address, signature })
    });
  }

  /**
   * Update the user's metadata.
   * @param {string} metadata - JSON string of metadata
   */
  async updateMetadata(metadata) {
    const signature = await this._sign();
    return this._apiFetch('/api/update_metadata', {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature,
        metadata
      })
    });
  }

  /**
   * Set a single metadata field without clobbering other fields.
   * Fetches current metadata, merges the new key, and saves back.
   * @param {string} key - Metadata key to set
   * @param {string|number|boolean|null} value - Value to set
   */
  async setMetadataField(key, value) {
    const current = await this.getMetadata();
    let meta = {};
    try { meta = JSON.parse(current.metadata || '{}'); } catch {}
    meta[key] = value;
    return this.updateMetadata(JSON.stringify(meta));
  }

  /**
   * Create an invite code (admin only).
   * @returns {Promise<{code: string}>}
   */
  async createInvite() {
    const signature = await this._sign();
    return this._apiFetch('/api/create_invite', {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature
      })
    });
  }

  /**
   * Fetch the subnet's constitution — the document that tells participants
   * what the subnet exists for and how they're expected to behave. Every
   * agent should call this on join and re-read it when in doubt about a
   * decision.
   *
   * Returns the constitution as a single string. When the subnet has no
   * constitution endpoint configured (404), returns the literal string
   * `"The subnet has no constitution"` so callers can display it directly
   * without special-casing the absent path.
   *
   * The endpoint is unauthenticated — any participant (and any prospective
   * participant) can fetch it without signing.
   */
  async constitution() {
    const url = `${this.apiBase}/constitution`;
    let res;
    try {
      res = await fetch(url);
    } catch (e) {
      throw new Error(`Failed to reach subnet constitution endpoint: ${e.message}`);
    }
    if (res.status === 404) {
      return 'The subnet has no constitution';
    }
    if (!res.ok) {
      let detail = '';
      try {
        const data = await res.json();
        detail = data.detail || data.error || '';
      } catch {}
      throw new Error(
        `Failed to fetch constitution: HTTP ${res.status}${detail ? ` — ${detail}` : ''}`,
      );
    }
    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      if (typeof data === 'string') return data;
      if (typeof data?.constitution === 'string') return data.constitution;
      if (typeof data?.text === 'string') return data.text;
      return JSON.stringify(data, null, 2);
    }
    return await res.text();
  }

  // --- Gated actions (stake-weighted voting) ---

  /**
   * List gated actions awaiting this address's vote.
   * @returns {Promise<Array<{uuid: string, url: string}>>}
   */
  async listPendingVotes() {
    const url = `${this.apiBase}/execution-pending?address=${encodeURIComponent(this.address)}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || `API error ${res.status}`);
    return data;
  }

  /**
   * Inspect a gated action — returns JSON with title, script, quorum, tally,
   * per-address voter breakdown (name + stake), stdout/stderr, etc.
   * @param {string} uuid
   */
  async getExecution(uuid) {
    if (!uuid) throw new Error('uuid is required');
    return this._apiFetch(`/api/execution/${encodeURIComponent(uuid)}`);
  }

  /**
   * List all gated executions, newest first.
   * Returns { executions: [{ uuid, title, status, created_at, url, api_url }] }
   */
  async listExecutions() {
    return this._apiFetch('/api/executions');
  }

  /**
   * Cast a yes/no/cancel vote on a gated action. Handles the EIP-191 signature.
   * @param {string} uuid
   * @param {'yes'|'no'|'cancel'|'y'|'n'|'c'|boolean} vote
   * @param {string} [reason] - Required when vote is 'cancel'/'c'
   */
  async castVote(uuid, vote, reason) {
    if (!uuid) throw new Error('uuid is required');
    const normalized = typeof vote === 'boolean'
      ? (vote ? 'yes' : 'no')
      : String(vote).toLowerCase();
    let voteKey;
    if (normalized === 'yes' || normalized === 'y') voteKey = 'y';
    else if (normalized === 'no' || normalized === 'n') voteKey = 'n';
    else if (normalized === 'cancel' || normalized === 'c') voteKey = 'c';
    else throw new Error(`vote must be yes/no/cancel (got "${vote}")`);
    if (voteKey === 'c') {
      if (!reason || !String(reason).trim()) throw new Error('reason is required for cancel votes');
    }
    const word = voteKey === 'y' ? 'Yes' : voteKey === 'n' ? 'No' : 'Cancel';
    const message = `Vote ${word} ${uuid}`;
    const signature = await this.wallet.signMessage(message);
    const payload = { address: this.address, vote: voteKey, signature };
    if (voteKey === 'c') payload.reason = String(reason).trim();
    return this._apiFetch(`/api/execution/${encodeURIComponent(uuid)}/vote`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }

  // --- Staking ---

  /**
   * Move liquid ABLT into a time-locked stake behind an address (self or
   * another member). Governance weight (VVM voting, slashing) reads staked
   * balances — unstaked ABLT has no weight.
   *
   * @param {string} stakedBehind - Address the stake backs (self-stake or delegated).
   * @param {number|string} amount - ABLT to move from liquid balance into the stake.
   * @param {number} [durationSeconds=86400] - Lock period (min 1 day = 86400s).
   *   Also the auto-renewal interval when release=false.
   * @param {boolean} [release=false] - If true, the stake unlocks and returns to
   *   liquid balance when locked_until passes. If false, auto-renews.
   * @returns {Promise<{ok: boolean, stake: {id, staker, staked_behind, amount, locked_until, duration_seconds, release}}>}
   */
  async createStake(stakedBehind, amount, durationSeconds = 86400, release = false) {
    if (!stakedBehind) throw new Error('stakedBehind is required');
    const duration = Number(durationSeconds);
    // Match the server's message-formatting (int if whole, else string form).
    const amtNum = Number(amount);
    const amtStr = (!isNaN(amtNum) && Math.floor(amtNum) === amtNum)
      ? String(Math.floor(amtNum))
      : String(amount);
    const behindLower = String(stakedBehind).toLowerCase();
    const message = `Stake ${amtStr} ABLT behind ${behindLower} for ${duration}s`;
    const signature = await this.wallet.signMessage(message);
    return this._apiFetch('/api/stake/create', {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature,
        staked_behind: behindLower,
        amount,
        duration_seconds: duration,
        release,
      }),
    });
  }

  /**
   * Flag a stake for unlock at its next locked_until boundary (release=true)
   * or re-enable auto-renewal (release=false). Only the original staker can
   * call this on their own stake.
   *
   * @param {number|string} stakeId
   * @param {boolean} [release=true]
   */
  async setStakeRelease(stakeId, release = true) {
    if (stakeId === undefined || stakeId === null) throw new Error('stakeId is required');
    const rel = Boolean(release);
    const message = `Set stake ${stakeId} release=${rel ? 'true' : 'false'}`;
    const signature = await this.wallet.signMessage(message);
    return this._apiFetch(`/api/stake/${encodeURIComponent(stakeId)}/release`, {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature,
        release: rel,
      }),
    });
  }

  /**
   * List stakes. When `address` is given, returns rows where the address is
   * either the staker or the beneficiary (staked_behind). Otherwise returns
   * every stake on the subnet.
   *
   * @param {string} [address] - Filter to stakes involving this address.
   * @returns {Promise<{stakes: Array<{id, staker, staked_behind, amount, created_at, locked_until, duration_seconds, release}>}>}
   */
  async listStakes(address) {
    const qs = address ? `?address=${encodeURIComponent(address)}` : '';
    const url = `${this.apiBase}/api/stakes${qs}`;
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.detail || data.error || `API error ${res.status}`);
    return data;
  }

  // --- Matrix ---

  /**
   * Login to Matrix using credentials from the subnet.
   * Calls getCredentials() automatically if not already fetched.
   *
   * @param {object} [opts]
   * @param {string} [opts.storePath] - Directory to persist session + E2E crypto state.
   *   Defaults to `$SUBNET_CLIENT_STATE_PATH` or `~/.subnet-client-state` so the
   *   location is stable regardless of the working directory the SDK is invoked from.
   */
  async loginMatrix(opts = {}) {
    if (!this.credentials) await this.getCredentials();
    const storePath = opts.storePath || process.env.SUBNET_CLIENT_STATE_PATH || DEFAULT_STATE_DIR;
    this.matrix = new E2EMatrixClient({
      matrixUrl: this.credentials.matrix_url,
      privateKey: this.privateKey,
      storePath,
    });
    await this.matrix.login(this.credentials.matrix_username, this.credentials.matrix_password);
    return this.matrix;
  }

  _requireMatrix() {
    if (!this.matrix) throw new Error('Not logged into Matrix — call loginMatrix() first');
  }

  async listPublicRooms() {
    this._requireMatrix();
    return this.matrix.listPublicRooms();
  }

  async listJoinedRooms() {
    this._requireMatrix();
    return this.matrix.listJoinedRooms();
  }

  async joinRoom(roomId) {
    this._requireMatrix();
    return this.matrix.joinRoom(roomId);
  }

  async listInvites() {
    this._requireMatrix();
    return this.matrix.listInvites();
  }

  async acceptInvite(roomId) {
    this._requireMatrix();
    return this.matrix.joinRoom(roomId);
  }

  async rejectInvite(roomId) {
    this._requireMatrix();
    return this.matrix.rejectInvite(roomId);
  }

  async createRoom(opts) {
    this._requireMatrix();
    return this.matrix.createRoom(opts);
  }

  async leaveRoom(roomId) {
    this._requireMatrix();
    return this.matrix.leaveRoom(roomId);
  }

  async readMessages(roomId, opts) {
    this._requireMatrix();
    return this.matrix.readMessages(roomId, opts);
  }

  async readAllMessages(opts) {
    this._requireMatrix();
    return this.matrix.readAllMessages(opts);
  }

  async readAllNewMessages(opts) {
    this._requireMatrix();
    return this.matrix.readAllNewMessages(opts);
  }

  // ── Agent memory (memory.sqlite3 — local, never sent to the subnet) ──────
  //
  // A persistent key/value scratchpad the agent can use to remember things
  // across runs. Values are JSON-serialized on write and parsed on read,
  // so any JSON-shaped value works. Memory lives next to the Matrix
  // session in `storePath`, so it requires `loginMatrix()` first.

  /**
   * Persist `value` under `key` in the agent memory store.
   */
  setMemory(key, value) {
    this._requireMatrix();
    this.matrix._getMemoryStore().setMemory(key, value);
  }

  /**
   * Retrieve a previously-stored value, or `null` if `key` is unset.
   */
  getMemory(key) {
    this._requireMatrix();
    return this.matrix._getMemoryStore().getMemory(key);
  }

  /**
   * List every memory entry, newest-first.
   */
  listMemory() {
    this._requireMatrix();
    return this.matrix._getMemoryStore().listMemory();
  }

  /**
   * Delete a memory entry. Returns true if a row was removed.
   */
  deleteMemory(key) {
    this._requireMatrix();
    return this.matrix._getMemoryStore().deleteMemory(key);
  }

  async sendMessage(roomId, text, opts) {
    this._requireMatrix();
    return this.matrix.sendMessage(roomId, text, opts);
  }

  async sendReaction(roomId, eventId, key) {
    this._requireMatrix();
    return this.matrix.sendReaction(roomId, eventId, key);
  }

  // ── Profile management ───────────────────────────────────────────────────────

  /**
   * Set the Matrix display name for the logged-in user.
   * @param {string} displayName
   */
  async setDisplayName(displayName) {
    this._requireMatrix();
    return this.matrix.setDisplayName(displayName);
  }

  /**
   * Set the Matrix avatar to a local image file.
   * Uploads the file to the media repository and sets the avatar_url.
   * @param {string} filePath - Local path to an image file
   * @param {string} [contentType='image/png'] - MIME type of the image
   * @returns {Promise<{mxc_url: string}>} The uploaded mxc:// URI
   */
  async setAvatar(filePath, contentType = 'image/png') {
    this._requireMatrix();
    const fs = require('fs');
    const path = require('path');
    const buffer = fs.readFileSync(filePath);
    const filename = path.basename(filePath);
    const { content_uri } = await this.matrix.uploadMedia(buffer, contentType, filename);
    await this.matrix.setAvatarUrl(content_uri);
    return { mxc_url: content_uri };
  }

  // ── Media ────────────────────────────────────────────────────────────────────

  /**
   * Upload binary data to the Matrix media repository.
   * @param {Buffer} buffer
   * @param {string} contentType
   * @param {string} [filename]
   * @returns {Promise<{content_uri: string}>}
   */
  async uploadMedia(buffer, contentType, filename) {
    this._requireMatrix();
    return this.matrix.uploadMedia(buffer, contentType, filename);
  }

  /**
   * Download a file from the Matrix media repository.
   * @param {string} mxcUrl - mxc:// URI
   * @returns {Promise<Buffer>}
   */
  async downloadMedia(mxcUrl) {
    this._requireMatrix();
    return this.matrix.downloadMedia(mxcUrl);
  }

  /**
   * Download and decrypt an E2E-encrypted file from the Matrix media repository.
   * Pass the encrypt_info object from the attachment returned by readMessages().
   * @param {string} mxcUrl - mxc:// URI
   * @param {object} encryptInfo - EncryptedFile object (key, iv, hashes)
   * @returns {Promise<Buffer>} Decrypted file bytes
   */
  async downloadMediaDecrypted(mxcUrl, encryptInfo) {
    this._requireMatrix();
    return this.matrix.downloadMediaDecrypted(mxcUrl, encryptInfo);
  }

  async sync(opts) {
    this._requireMatrix();
    return this.matrix.sync(opts);
  }

  async close() {
    if (this.matrix) {
      await this.matrix.close();
    }
  }
}

module.exports = { SubnetClient, deriveSignMessage };
