'use strict';
/**
 * Browser delegation store. IndexedDB + WebCrypto AES-GCM.
 *
 * Layout — one database named `<namespace>::delegation` with two stores:
 *   - delegation_records: { envelope, delegate: {address}, iv, ciphertext, wrappedAt }
 *                          keyed by delegator address (lowercase)
 *   - delegation_keys:     a CryptoKey (AES-GCM, non-extractable) keyed the same way
 *
 * Non-extractable means same-origin JS can still encrypt/decrypt via
 * crypto.subtle but cannot read the raw key bytes — so the private key
 * ciphertext can only be decrypted by code that goes through WebCrypto
 * on this origin. That's the practical ceiling in a browser tab; an
 * attacker with persistent XSS still wins, but the key never sits in
 * plaintext at rest and can never be exfiltrated as bytes.
 */

const DEFAULT_NS = 'subnet-client-state';
const STORE_RECORDS = 'delegation_records';
const STORE_KEYS = 'delegation_keys';
const DB_VERSION = 1;

function _dbName(ns) { return `${ns}::delegation`; }

function _openDB(ns) {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(_dbName(ns), DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_RECORDS)) db.createObjectStore(STORE_RECORDS);
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _txGet(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readonly');
    const req = tx.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function _txPut(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function _txDelete(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function _getOrCreateKey(db, recordKey) {
  const existing = await _txGet(db, STORE_KEYS, recordKey);
  if (existing) return existing;
  const ck = await crypto.subtle.generateKey(
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
  await _txPut(db, STORE_KEYS, recordKey, ck);
  return ck;
}

const _enc = (s) => new TextEncoder().encode(s);
const _dec = (b) => new TextDecoder().decode(b);

function _haveCrypto() {
  return (
    typeof indexedDB !== 'undefined' &&
    typeof crypto !== 'undefined' &&
    typeof crypto.subtle !== 'undefined'
  );
}

class IDBDelegationStore {
  constructor(namespace) { this.ns = namespace || DEFAULT_NS; }

  async load(delegator) {
    if (!_haveCrypto()) return null;
    const key = String(delegator).toLowerCase();
    const db = await _openDB(this.ns);
    try {
      const rec = await _txGet(db, STORE_RECORDS, key);
      if (!rec) return null;
      const ck = await _txGet(db, STORE_KEYS, key);
      if (!ck) return null;
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: rec.iv },
        ck,
        rec.ciphertext,
      );
      return {
        envelope: rec.envelope,
        delegate: {
          address: rec.delegate.address,
          privateKey: _dec(new Uint8Array(plain)),
        },
      };
    } finally { db.close(); }
  }

  async save(record) {
    if (!_haveCrypto()) {
      throw new Error('Delegation cache unavailable: this browser context has no IndexedDB or WebCrypto.');
    }
    const key = String(record.envelope.delegator).toLowerCase();
    const db = await _openDB(this.ns);
    try {
      const ck = await _getOrCreateKey(db, key);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        ck,
        _enc(record.delegate.privateKey),
      );
      await _txPut(db, STORE_RECORDS, key, {
        envelope: record.envelope,
        delegate: { address: record.delegate.address },
        iv,
        ciphertext: new Uint8Array(ct),
        wrappedAt: Date.now(),
      });
    } finally { db.close(); }
  }

  async clear(delegator) {
    if (!_haveCrypto()) return;
    const key = String(delegator).toLowerCase();
    const db = await _openDB(this.ns);
    try {
      await _txDelete(db, STORE_RECORDS, key);
      await _txDelete(db, STORE_KEYS, key);
    } finally { db.close(); }
  }
}

function createDelegationStore(opts = {}) {
  return new IDBDelegationStore(opts.namespace);
}

module.exports = { createDelegationStore, IDBDelegationStore };
