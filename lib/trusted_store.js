'use strict';
/**
 * Trusted-address allowlist — a locally-cached, opt-in filter.
 *
 * When the list is non-empty the SubnetClient narrows every read so the agent
 * only sees messages from, and members corresponding to, the trusted
 * addresses (its own address is always implicitly trusted so it can still see
 * what it sent and itself in the roster). When the list is empty the filter is
 * inert and the client behaves exactly as before — nothing is changed.
 *
 * The list is persisted so it survives across runs ("perma-cached") and can be
 * cleared at any time. Backends, picked automatically:
 *   - Node:    `trusted_addresses.json` in the subnet-client state dir.
 *   - Browser: `localStorage`, namespaced by the account address.
 *   - Neither: in-memory only (lasts for the process lifetime).
 *
 * Addresses are stored checksummed and de-duplicated case-insensitively.
 */

const { ethers } = require('ethers');
const nodeOnly = require('#node-only');

const FILE_NAME = 'trusted_addresses.json';
const LS_PREFIX = 'subnet-client:trusted:';

function normalizeAddress(address) {
  return ethers.getAddress(String(address).trim());
}

function dedupeChecksummed(addresses) {
  const seen = new Set();
  const out = [];
  for (const a of addresses) {
    let checksummed;
    try {
      checksummed = normalizeAddress(a);
    } catch {
      continue;
    }
    const lc = checksummed.toLowerCase();
    if (!seen.has(lc)) {
      seen.add(lc);
      out.push(checksummed);
    }
  }
  return out;
}

class TrustedStore {
  /**
   * @param {object} [opts]
   * @param {string} [opts.storePath] - Directory for the JSON file (Node).
   * @param {string} [opts.address] - Account address, used to namespace the
   *   localStorage key in the browser so two accounts in one origin don't
   *   share a list.
   */
  constructor({ storePath, address } = {}) {
    this.storePath = storePath || null;
    this.address = address || null;
    this._cache = null;
    this._mem = null;
  }

  _backend() {
    if (nodeOnly.fs && nodeOnly.path && this.storePath) return 'file';
    if (typeof localStorage !== 'undefined') return 'localStorage';
    return 'memory';
  }

  _filePath() {
    return nodeOnly.path.join(this.storePath, FILE_NAME);
  }

  _lsKey() {
    return LS_PREFIX + (this.address ? this.address.toLowerCase() : 'default');
  }

  _readRaw() {
    const backend = this._backend();
    if (backend === 'file') {
      const fp = this._filePath();
      if (!nodeOnly.fs.existsSync(fp)) return null;
      return nodeOnly.fs.readFileSync(fp, 'utf8');
    }
    if (backend === 'localStorage') {
      return localStorage.getItem(this._lsKey());
    }
    return this._mem;
  }

  _load() {
    if (this._cache) return this._cache;
    const raw = this._readRaw();
    let stored = [];
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed?.addresses)) stored = parsed.addresses;
      } catch {}
    }
    this._cache = dedupeChecksummed(stored);
    return this._cache;
  }

  _write(list) {
    const payload = JSON.stringify({ addresses: list, updated_at: Date.now() });
    const backend = this._backend();
    if (backend === 'file') {
      nodeOnly.fs.mkdirSync(this.storePath, { recursive: true });
      nodeOnly.fs.writeFileSync(this._filePath(), payload);
    } else if (backend === 'localStorage') {
      localStorage.setItem(this._lsKey(), payload);
    } else {
      this._mem = payload;
    }
    this._cache = list;
  }

  /** Drop the in-memory cache so the next read re-loads from disk/storage. */
  reload() {
    this._cache = null;
  }

  /** Current trusted addresses, checksummed. Empty array when the filter is off. */
  list() {
    return [...this._load()];
  }

  isEmpty() {
    return this._load().length === 0;
  }

  has(address) {
    let lc;
    try {
      lc = normalizeAddress(address).toLowerCase();
    } catch {
      return false;
    }
    return this._load().some((a) => a.toLowerCase() === lc);
  }

  /**
   * Add one or more addresses. Invalid addresses throw (so a typo surfaces
   * instead of silently widening the allowlist). Returns the full new list.
   */
  add(addresses) {
    const checksummed = addresses.map(normalizeAddress);
    const next = dedupeChecksummed([...this._load(), ...checksummed]);
    this._write(next);
    return this.list();
  }

  /** Remove one or more addresses (no-op for ones not present). Returns the new list. */
  remove(addresses) {
    const drop = new Set();
    for (const a of addresses) {
      try {
        drop.add(normalizeAddress(a).toLowerCase());
      } catch {}
    }
    const next = this._load().filter((a) => !drop.has(a.toLowerCase()));
    this._write(next);
    return this.list();
  }

  /** Remove the entire list, deleting the backing file/key — filter goes inert. */
  clear() {
    const backend = this._backend();
    if (backend === 'file') {
      const fp = this._filePath();
      if (nodeOnly.fs.existsSync(fp)) nodeOnly.fs.unlinkSync(fp);
    } else if (backend === 'localStorage') {
      localStorage.removeItem(this._lsKey());
    } else {
      this._mem = null;
    }
    this._cache = [];
  }
}

function createTrustedStore(opts) {
  return new TrustedStore(opts);
}

module.exports = { TrustedStore, createTrustedStore, normalizeAddress };
