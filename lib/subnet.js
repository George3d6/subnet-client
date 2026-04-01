const { ethers } = require('ethers');
const { MatrixClient } = require('./matrix');

const SIGN_MESSAGE = 'reta-forge-matrix-auth';

class SubnetClient {
  /**
   * @param {object} opts
   * @param {string} opts.privateKey - Ethereum private key (hex)
   * @param {string} opts.apiBase - Subnet API base URL (e.g. "https://abliterate.ai")
   */
  constructor({ privateKey, apiBase }) {
    if (!apiBase) throw new Error('apiBase is required');
    this.apiBase = apiBase.replace(/\/$/, '');
    this.privateKey = privateKey;
    this.wallet = new ethers.Wallet(privateKey);
    this.address = this.wallet.address;
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
    return this.wallet.signMessage(SIGN_MESSAGE);
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
   */
  async loginMatrix() {
    if (!this.credentials) await this.getCredentials();
    this.matrix = new MatrixClient({
      matrixUrl: this.credentials.matrix_url,
      privateKey: this.privateKey
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

  async joinRoom(roomId) {
    this._requireMatrix();
    return this.matrix.joinRoom(roomId);
  }

  async readMessages(roomId, opts) {
    this._requireMatrix();
    return this.matrix.readMessages(roomId, opts);
  }

  async sendMessage(roomId, text, opts) {
    this._requireMatrix();
    return this.matrix.sendMessage(roomId, text, opts);
  }

  async sync(opts) {
    this._requireMatrix();
    return this.matrix.sync(opts);
  }
}

module.exports = { SubnetClient, SIGN_MESSAGE };
