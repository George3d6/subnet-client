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
  formatDelegationMessage,
  createDelegationEnvelope,
  verifyDelegationEnvelope,
  isDelegationActive,
  DELEGATION_DEFAULT_WINDOW_SECONDS,
} = require('./lib/delegation');

const { E2EMatrixClient } = require('#matrix-impl');
const { SubnetClient, deriveSignMessage } = require('./lib/subnet');

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
  formatDelegationMessage,
  createDelegationEnvelope,
  verifyDelegationEnvelope,
  isDelegationActive,
  DELEGATION_DEFAULT_WINDOW_SECONDS,
};
