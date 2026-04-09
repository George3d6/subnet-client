'use strict';
/**
 * Cross-signing primitives for the bot identity.
 *
 * The matrix-sdk-crypto-nodejs napi binding (v0.4.x) exposes
 * `OlmMachine.bootstrapCrossSigning(reset)` but it returns void and never
 * queues the resulting upload requests through `outgoingRequests()`. The
 * binding generates the master/self-signing/user-signing keypairs locally
 * and then has no way to surface them to the caller for upload to the
 * server. (Probe-verified — see /tmp/olm_probe/probe_xs2.js.)
 *
 * To work around this we generate the cross-signing keypairs ourselves
 * with Node's `crypto.generateKeyPairSync('ed25519')`, sign them in
 * canonical-JSON form, and upload them through the standard Matrix REST
 * endpoints. The private parts live in `<storePath>/cross_signing.json`
 * so subsequent runs of the same bot reuse the same identity. This file
 * is the only thing the operator must protect to maintain a stable
 * cross-signed identity across machines.
 *
 * The cross-signing chain we produce mirrors what Element / Synapse
 * expect:
 *   master self-signs
 *   master signs self_signing_key
 *   master signs user_signing_key
 *   self_signing_key signs the bot's `device_keys` JSON
 *
 * Once that chain is uploaded, Element drops the "unverified device"
 * warning shield next to the bot's messages.
 */

const crypto = require('crypto');

// ── Encoding helpers ─────────────────────────────────────────────────────────

/**
 * Matrix uses canonical JSON for signing: keys sorted lexicographically,
 * no whitespace, UTF-8 strings with the minimal escaping JSON.stringify
 * already produces. We don't need full normalization (no number coercion
 * etc.) because everything we sign is shaped by us.
 */
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}';
}

/** Matrix uses *unpadded* base64 throughout — strip the trailing `=`s. */
function base64Unpadded(buf) {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '');
}

function base64UnpaddedDecode(s) {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

// ── Ed25519 KeyObject <-> raw bytes ──────────────────────────────────────────
//
// Node's crypto exposes Ed25519 keys as KeyObjects, but we want to persist
// the raw 32-byte private/public halves (the same shape Matrix uses on
// the wire). PKCS8 / SPKI DER encodings of an Ed25519 key are a fixed
// ASN.1 prefix followed by exactly 32 bytes of key material — so the raw
// bytes live at the tail, and we can rebuild a KeyObject by prepending
// the standard prefix.

// PKCS8 prefix for an Ed25519 private key (16 bytes).
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');
// SPKI prefix for an Ed25519 public key (12 bytes).
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function privateKeyFromRaw(raw32) {
  const der = Buffer.concat([ED25519_PKCS8_PREFIX, raw32]);
  return crypto.createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
}

function publicKeyFromRaw(raw32) {
  const der = Buffer.concat([ED25519_SPKI_PREFIX, raw32]);
  return crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
}

/**
 * Generate a fresh Ed25519 keypair and return both the unpadded-base64
 * encoded raw bytes (for persistence + Matrix wire format) and the KeyObject
 * pair (for immediate signing without re-importing).
 */
function generateEd25519Keypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const pubRaw = publicKey.export({ type: 'spki', format: 'der' }).slice(-32);
  const privRaw = privateKey.export({ type: 'pkcs8', format: 'der' }).slice(-32);
  return {
    publicBase64: base64Unpadded(pubRaw),
    privateBase64: base64Unpadded(privRaw),
    publicKey,
    privateKey,
  };
}

/**
 * Re-hydrate a stored keypair from the public/private base64 pair.
 */
function loadEd25519Keypair(stored) {
  const pubRaw = base64UnpaddedDecode(stored.public);
  const privRaw = base64UnpaddedDecode(stored.private);
  return {
    publicBase64: stored.public,
    privateBase64: stored.private,
    publicKey: publicKeyFromRaw(pubRaw),
    privateKey: privateKeyFromRaw(privRaw),
  };
}

// ── Matrix signing helpers ───────────────────────────────────────────────────

/**
 * Produce a Matrix-style detached signature over `obj`. Per the spec, the
 * `signatures` and `unsigned` keys are stripped before canonicalization,
 * the canonical form is signed with raw Ed25519 (no prehashing), and the
 * resulting 64-byte signature is unpadded base64.
 */
function signMatrixObject(obj, privateKey) {
  const { signatures, unsigned, ...rest } = obj;
  const canonical = canonicalJson(rest);
  const sig = crypto.sign(null, Buffer.from(canonical, 'utf8'), privateKey);
  return base64Unpadded(sig);
}

/**
 * Build one of the three CrossSigningKey JSON objects (master, self_signing,
 * user_signing) and self-sign it with the supplied signers.
 *
 * @param {object} args
 * @param {string} args.userId         - Owning user ID, e.g. `@alice:example.com`
 * @param {string[]} args.usage        - One of `["master"]`, `["self_signing"]`, `["user_signing"]`
 * @param {string} args.publicBase64   - The key's own public part (unpadded base64)
 * @param {Array<{keyId: string, privateKey: crypto.KeyObject}>} args.signers
 *   - Each signer's `keyId` is `ed25519:<base64-public>` of the *signing* key.
 */
function buildSignedCrossSigningKey({ userId, usage, publicBase64, signers }) {
  const obj = {
    user_id: userId,
    usage,
    keys: { [`ed25519:${publicBase64}`]: publicBase64 },
  };
  for (const signer of signers) {
    const sig = signMatrixObject(obj, signer.privateKey);
    if (!obj.signatures) obj.signatures = {};
    if (!obj.signatures[userId]) obj.signatures[userId] = {};
    obj.signatures[userId][signer.keyId] = sig;
  }
  return obj;
}

/**
 * Add a self-signing-key signature to an existing `device_keys` object
 * fetched from `/keys/query`. Returns a fresh object containing only the
 * fields the `/keys/signatures/upload` endpoint requires (the full
 * `device_keys` plus the new signature merged into `signatures`).
 *
 * The Matrix spec says: strip `signatures` + `unsigned`, canonicalize,
 * sign with the SSK private key. The signing key's identifier on the
 * resulting signature is `ed25519:<ssk-public-base64>`.
 */
function signDeviceKeys({ deviceKeys, sskPublicBase64, sskPrivateKey }) {
  const sig = signMatrixObject(deviceKeys, sskPrivateKey);
  const userId = deviceKeys.user_id;
  // Deep-clone the existing signatures so we don't mutate the input.
  const merged = JSON.parse(JSON.stringify(deviceKeys));
  if (!merged.signatures) merged.signatures = {};
  if (!merged.signatures[userId]) merged.signatures[userId] = {};
  merged.signatures[userId][`ed25519:${sskPublicBase64}`] = sig;
  return merged;
}

module.exports = {
  canonicalJson,
  base64Unpadded,
  base64UnpaddedDecode,
  generateEd25519Keypair,
  loadEd25519Keypair,
  signMatrixObject,
  buildSignedCrossSigningKey,
  signDeviceKeys,
};
