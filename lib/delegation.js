'use strict';
/**
 * Delegation envelopes.
 *
 * A delegation envelope lets a "main" address authorize a different address
 * (the delegate) to sign accountability messages on its behalf for a bounded
 * time window. The delegate runs as its own ephemeral keypair — locally
 * generated, cached by the SDK so a refresh doesn't burn another wallet
 * popup. Verifiers recover the delegate's address from the per-message
 * signatures, then verify the envelope's signature recovers to the
 * delegator and that `now ∈ [from, until)`.
 *
 * Canonical signed text:
 *   "I delegate signing to this address: <addr> from <ISO> to <ISO>"
 *
 * `from`/`until` are stored as integer UNIX seconds in the envelope and
 * rendered as ISO 8601 (UTC, ms-precision) in the signed text. The envelope
 * is the source of truth — verifiers reconstruct the text from envelope
 * fields, so any ambiguity in date formatting on the consumer side is moot.
 */

const { ethers } = require('ethers');

const DELEGATION_DEFAULT_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const DELEGATION_PREFIX = 'I delegate signing to this address: ';

function _isoFromSeconds(s) {
  return new Date(s * 1000).toISOString();
}

/**
 * Canonical EIP-191 text for a delegation. Inputs are normalized: `to` is
 * checksummed, `from`/`until` floored to seconds. Output is deterministic
 * so the same envelope always signs the same text.
 */
function formatDelegationMessage({ to, from, until }) {
  const toAddr = ethers.getAddress(to);
  const f = Math.floor(Number(from));
  const u = Math.floor(Number(until));
  return `${DELEGATION_PREFIX}${toAddr} from ${_isoFromSeconds(f)} to ${_isoFromSeconds(u)}`;
}

/**
 * Sign a delegation with the main signer.
 *
 * @param {object} args
 * @param {{ signMessage: (text: string) => Promise<string>, address?: string, getAddress?: () => Promise<string> }} args.mainSigner
 * @param {string} args.delegateAddress
 * @param {number} [args.from] - UNIX seconds; defaults to now.
 * @param {number} [args.until] - UNIX seconds; defaults to from + 1 week.
 * @returns {Promise<{delegator: string, to: string, from: number, until: number, signature: string}>}
 */
async function createDelegationEnvelope({ mainSigner, delegateAddress, from, until }) {
  if (!mainSigner || typeof mainSigner.signMessage !== 'function') {
    throw new Error('createDelegationEnvelope requires a signer with signMessage()');
  }
  const to = ethers.getAddress(delegateAddress);
  const now = Math.floor(Date.now() / 1000);
  const fromS = Number.isFinite(Number(from)) && from !== null && from !== undefined
    ? Math.floor(Number(from))
    : now;
  const untilS = Number.isFinite(Number(until)) && until !== null && until !== undefined
    ? Math.floor(Number(until))
    : fromS + DELEGATION_DEFAULT_WINDOW_SECONDS;
  if (untilS <= fromS) throw new Error('Delegation `until` must be after `from`');

  const text = formatDelegationMessage({ to, from: fromS, until: untilS });
  const signature = await mainSigner.signMessage(text);

  let delegator = null;
  if (typeof mainSigner.address === 'string') {
    delegator = mainSigner.address;
  } else if (typeof mainSigner.getAddress === 'function') {
    try { delegator = await mainSigner.getAddress(); } catch {}
  }
  if (!delegator) delegator = ethers.verifyMessage(text, signature);

  return {
    delegator: ethers.getAddress(delegator),
    to,
    from: fromS,
    until: untilS,
    signature,
  };
}

/**
 * Verify the envelope's signature recovers to the claimed delegator.
 * Does *not* check the time window — use `isDelegationActive` for that.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
function verifyDelegationEnvelope(env) {
  if (!env || typeof env !== 'object') return { ok: false, reason: 'missing envelope' };
  const { delegator, to, from, until, signature } = env;
  if (!delegator || !to || !signature) return { ok: false, reason: 'missing fields' };
  if (!Number.isFinite(Number(from)) || !Number.isFinite(Number(until))) {
    return { ok: false, reason: 'bad timestamps' };
  }
  let recovered;
  try {
    recovered = ethers.verifyMessage(
      formatDelegationMessage({ to, from, until }),
      signature,
    );
  } catch (e) {
    return { ok: false, reason: `recovery failed: ${e.message}` };
  }
  if (recovered.toLowerCase() !== String(delegator).toLowerCase()) {
    return { ok: false, reason: 'signature does not match delegator' };
  }
  return { ok: true };
}

/**
 * True iff the envelope verifies AND `now ∈ [from, until)`.
 * @param {object} env
 * @param {number} [now] - UNIX seconds.
 */
function isDelegationActive(env, now = Math.floor(Date.now() / 1000)) {
  const v = verifyDelegationEnvelope(env);
  if (!v.ok) return false;
  return now >= Number(env.from) && now < Number(env.until);
}

module.exports = {
  DELEGATION_PREFIX,
  DELEGATION_DEFAULT_WINDOW_SECONDS,
  formatDelegationMessage,
  createDelegationEnvelope,
  verifyDelegationEnvelope,
  isDelegationActive,
};
