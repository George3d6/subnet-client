'use strict';
/**
 * Node delegation store. One JSON file per delegator under
 * `<storePath>/delegations/<delegator-lowercase>.json`, written 0600.
 * Plaintext on disk — same posture as the existing session.json and
 * cross_signing.json that already live in the state directory.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_STATE_DIR = path.join(os.homedir(), '.subnet-client-state');

class FileDelegationStore {
  constructor(storePath) {
    this.storePath = path.resolve(
      storePath || process.env.SUBNET_CLIENT_STATE_PATH || DEFAULT_STATE_DIR,
    );
    this.dir = path.join(this.storePath, 'delegations');
  }

  _file(delegator) {
    return path.join(this.dir, `${String(delegator).toLowerCase()}.json`);
  }

  async load(delegator) {
    try {
      const raw = fs.readFileSync(this._file(delegator), 'utf8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  async save(record) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(
      this._file(record.envelope.delegator),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
  }

  async clear(delegator) {
    try { fs.unlinkSync(this._file(delegator)); } catch {}
  }
}

function createDelegationStore(opts = {}) {
  return new FileDelegationStore(opts.storePath);
}

module.exports = { createDelegationStore, FileDelegationStore };
