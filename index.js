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

const { E2EMatrixClient } = require('./lib/matrix_e2e');
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
  deriveSignMessage
};
