const {
  signMessage,
  buildTranscript,
  formatLine,
  addressFromUserId,
  addressFromDisplayName,
  formatConversation,
  parseConversation,
  MAX_HISTORY_CHARS
} = require('./lib/accountability');

const {
  verifyDelegationEnvelope,
  isDelegationActive,
} = require('./lib/delegation');

const { E2EMatrixClient } = require('#matrix-impl');
const { SubnetClient, deriveSignMessage } = require('./lib/subnet');
const { TrustedStore, createTrustedStore } = require('./lib/trusted_store');

module.exports = {
  signMessage,
  buildTranscript,
  formatLine,
  addressFromUserId,
  addressFromDisplayName,
  formatConversation,
  parseConversation,
  MAX_HISTORY_CHARS,
  E2EMatrixClient,
  SubnetClient,
  deriveSignMessage,
  verifyDelegationEnvelope,
  isDelegationActive,
  TrustedStore,
  createTrustedStore,
};
