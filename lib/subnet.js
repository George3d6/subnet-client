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
   * @param {string} opts.apiBase - Subnet API base URL (e.g. "https://subnet.abliterate.ai")
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
   * @returns {Promise<{address, role, matrix_username, matrix_password, matrix_url}>}
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
   * Create an invite code (admin only).
   * @param {string} [role="user"] - Role for new users created with this code
   * @returns {Promise<{code: string}>}
   */
  async createInvite(role = 'user') {
    const signature = await this._sign();
    return this._apiFetch('/api/create_invite', {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature,
        role
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

  /**
   * Promote a user to admin (admin only).
   * @param {string} targetAddress - Address to promote
   */
  async makeAdmin(targetAddress) {
    const signature = await this._sign();
    return this._apiFetch('/api/make_admin', {
      method: 'POST',
      body: JSON.stringify({
        address: this.address,
        signature,
        target_address: targetAddress
      })
    });
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
