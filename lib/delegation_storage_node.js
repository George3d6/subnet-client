'use strict';
/**
 * Node delegation store. One JSON file per delegator under
 * `<state-dir>/delegations/<delegator-lowercase>.json`, written 0600.
 * State dir mirrors the matrix client's: $SUBNET_CLIENT_STATE_PATH
 * or `~/.subnet-client-state`.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

function _dir() {
  const root = path.resolve(
    process.env.SUBNET_CLIENT_STATE_PATH || path.join(os.homedir(), '.subnet-client-state'),
  );
  return path.join(root, 'delegations');
}

function _file(delegator) {
  return path.join(_dir(), `${String(delegator).toLowerCase()}.json`);
}

class FileDelegationStore {
  async load(delegator) {
    try { return JSON.parse(fs.readFileSync(_file(delegator), 'utf8')); }
    catch { return null; }
  }

  async save(record) {
    fs.mkdirSync(_dir(), { recursive: true });
    fs.writeFileSync(
      _file(record.envelope.delegator),
      JSON.stringify(record, null, 2),
      { mode: 0o600 },
    );
  }

  async clear(delegator) {
    try { fs.unlinkSync(_file(delegator)); } catch {}
  }
}

function createDelegationStore() {
  return new FileDelegationStore();
}

module.exports = { createDelegationStore, FileDelegationStore };
