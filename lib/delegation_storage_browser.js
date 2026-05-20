'use strict';
/**
 * Browser delegation store. IndexedDB + WebCrypto AES-GCM.
 *
 * One database (`subnet-client-delegation`) with two object stores:
 *   - records: { envelope, delegate: {address}, iv, ciphertext } keyed by
 *              delegator address (lowercase).
 *   - meta:    holds a single non-extractable AES-GCM CryptoKey under
 *              the key 'master'. Non-extractable means same-origin JS can
 *              encrypt/decrypt but cannot read the raw bytes — the private
 *              key never sits in plaintext at rest.
 */

const DB_NAME = 'subnet-client-delegation';
const STORE_RECORDS = 'records';
const STORE_META = 'meta';

function _openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      db.createObjectStore(STORE_RECORDS);
      db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function _get(db, store, key) {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result ?? null);
    req.onerror = () => reject(req.error);
  });
}

function _put(db, store, key, value) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

function _del(db, store, key) {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function _masterKey(db) {
  let ck = await _get(db, STORE_META, 'master');
  if (ck) return ck;
  ck = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  await _put(db, STORE_META, 'master', ck);
  return ck;
}

class IDBDelegationStore {
  async load(delegator) {
    const key = String(delegator).toLowerCase();
    const db = await _openDB();
    try {
      const rec = await _get(db, STORE_RECORDS, key);
      if (!rec) return null;
      const ck = await _masterKey(db);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: rec.iv }, ck, rec.ciphertext);
      return {
        envelope: rec.envelope,
        delegate: { address: rec.delegate.address, privateKey: new TextDecoder().decode(plain) },
      };
    } finally { db.close(); }
  }

  async save(record) {
    const key = String(record.envelope.delegator).toLowerCase();
    const db = await _openDB();
    try {
      const ck = await _masterKey(db);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ct = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv },
        ck,
        new TextEncoder().encode(record.delegate.privateKey),
      );
      await _put(db, STORE_RECORDS, key, {
        envelope: record.envelope,
        delegate: { address: record.delegate.address },
        iv,
        ciphertext: new Uint8Array(ct),
      });
    } finally { db.close(); }
  }

  async clear(delegator) {
    const db = await _openDB();
    try { await _del(db, STORE_RECORDS, String(delegator).toLowerCase()); }
    finally { db.close(); }
  }
}

function createDelegationStore() {
  return new IDBDelegationStore();
}

module.exports = { createDelegationStore, IDBDelegationStore };
