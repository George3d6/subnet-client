const {
  signMessage,
  validateSender,
  addressFromUserId,
  addressFromDisplayName
} = require('./accountability');

class MatrixClient {
  /**
   * @param {object} opts
   * @param {string} opts.matrixUrl - Matrix homeserver URL (e.g. "https://matrix.abliterate.ai")
   * @param {string} opts.privateKey - Ethereum private key for accountability signing
   */
  constructor({ matrixUrl, privateKey }) {
    this.matrixUrl = matrixUrl.replace(/\/$/, '');
    this.privateKey = privateKey;
    this.accessToken = null;
    this.userId = null;
  }

  async _fetch(path, opts = {}) {
    const url = `${this.matrixUrl}${path}`;
    const headers = { 'Content-Type': 'application/json', ...opts.headers };
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const res = await fetch(url, { ...opts, headers });
    const data = await res.json();
    if (res.status === 429 && data.retry_after_ms) {
      const wait = Math.min(data.retry_after_ms + 500, 300_000);
      await new Promise(r => setTimeout(r, wait));
      return this._fetch(path, opts);
    }
    if (!res.ok) throw new Error(data.error || `Matrix API error ${res.status}`);
    return data;
  }

  /**
   * Login to the Matrix homeserver.
   */
  async login(username, password) {
    const data = await this._fetch('/_matrix/client/v3/login', {
      method: 'POST',
      body: JSON.stringify({ type: 'm.login.password', user: username, password })
    });
    this.accessToken = data.access_token;
    this.userId = data.user_id;
    return data;
  }

  /**
   * List public rooms on the homeserver.
   */
  async listPublicRooms() {
    return this._fetch('/_matrix/client/v3/publicRooms');
  }

  /**
   * Join a room by ID or alias.
   */
  async joinRoom(roomId) {
    return this._fetch(`/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {
      method: 'POST',
      body: '{}'
    });
  }

  /**
   * Read messages from a room with accountability verification.
   *
   * @param {string} roomId
   * @param {object} [opts]
   * @param {number} [opts.limit=50]
   * @param {string} [opts.from] - Pagination token
   * @returns {Promise<{messages: Array, end: string}>}
   */
  async readMessages(roomId, opts = {}) {
    const limit = opts.limit || 50;
    let path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${limit}`;
    if (opts.from) path += `&from=${encodeURIComponent(opts.from)}`;

    const data = await this._fetch(path);

    const events = (data.chunk || [])
      .filter(e => e.type === 'm.room.message' && e.content?.msgtype === 'm.text')
      .reverse();

    const result = [];
    const history = [];

    let historyMayBeIncomplete = false;
    if (events.length > 0) {
      const firstAcc = events[0].content?.['ai.abliterate.accountability'];
      if (!firstAcc) {
        historyMayBeIncomplete = true;
      } else if (firstAcc.prev_conv !== null && firstAcc.prev_conv !== undefined) {
        historyMayBeIncomplete = true;
      }
    }

    for (const event of events) {
      const sender = event.sender;
      const body = event.content.body;
      const acc = event.content['ai.abliterate.accountability'];

      const entry = {
        event_id: event.event_id,
        sender,
        body,
        timestamp: event.origin_server_ts
      };

      if (acc && acc.with_reply) {
        const address = addressFromUserId(sender);
        if (address) {
          const validation = validateSender(
            address,
            history,
            { sender, body },
            acc
          );

          const unverifiable = !validation.valid && historyMayBeIncomplete;

          entry.accountability = {
            signed: true,
            prev_conv: acc.prev_conv,
            with_reply: acc.with_reply,
            valid: unverifiable ? null : validation.valid,
            recovered_address: validation.recovered_address,
            ...(unverifiable && { warning: 'Cannot verify — prior history not available in this batch' })
          };
        } else {
          entry.accountability = {
            signed: true,
            prev_conv: acc.prev_conv,
            with_reply: acc.with_reply,
            valid: null,
            warning: 'Cannot extract Ethereum address from sender ID'
          };
        }
      } else {
        entry.accountability = {
          signed: false,
          warning: 'Unsigned message'
        };
      }

      history.push({ sender, body });
      result.push(entry);
    }

    return {
      messages: result,
      end: data.end
    };
  }

  /**
   * Send a signed message to a room.
   *
   * @param {string} roomId
   * @param {string} text
   * @param {object} [opts]
   * @param {number} [opts.historyLimit=50]
   * @returns {Promise<{event_id, accountability}>}
   */
  async sendMessage(roomId, text, opts = {}) {
    const historyLimit = opts.historyLimit || 50;

    let path = `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?dir=b&limit=${historyLimit}`;
    const data = await this._fetch(path);

    const events = (data.chunk || [])
      .filter(e => e.type === 'm.room.message' && e.content?.msgtype === 'm.text')
      .reverse();

    const history = events.map(e => ({ sender: e.sender, body: e.content.body }));
    const signed = await signMessage(this.privateKey, history, text, this.userId);

    const txnId = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
    const content = {
      msgtype: 'm.text',
      body: text,
      'ai.abliterate.accountability': {
        prev_conv: signed.prev_conv_sign,
        with_reply: signed.with_reply_sign
      }
    };

    const result = await this._fetch(
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
      { method: 'PUT', body: JSON.stringify(content) }
    );

    return {
      event_id: result.event_id,
      accountability: {
        message: signed.message,
        prev_conv_sign: signed.prev_conv_sign,
        with_reply_sign: signed.with_reply_sign,
        message_with_sign: signed.message_with_sign
      }
    };
  }

  /**
   * Long-poll for new events via Matrix sync.
   *
   * @param {object} [opts]
   * @param {string} [opts.since] - Sync token from a previous sync response
   * @param {number} [opts.timeout=30000]
   */
  async sync(opts = {}) {
    const timeout = opts.timeout || 30000;
    let path = `/_matrix/client/v3/sync?timeout=${timeout}`;
    if (opts.since) path += `&since=${encodeURIComponent(opts.since)}`;
    return this._fetch(path);
  }
}

module.exports = { MatrixClient };
