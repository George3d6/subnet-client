const {
  signMessage,
  validateSender,
  buildTranscript,
  formatLine,
  addressFromUserId,
  addressFromDisplayName,
  formatConversation,
  parseConversation,
  validateChain,
  MAX_HISTORY_CHARS
} = require('./lib/accountability');

const { MatrixClient } = require('./lib/matrix');
const { SubnetClient, SIGN_MESSAGE } = require('./lib/subnet');

module.exports = {
  signMessage,
  validateSender,
  buildTranscript,
  formatLine,
  addressFromUserId,
  addressFromDisplayName,
  formatConversation,
  parseConversation,
  validateChain,
  MAX_HISTORY_CHARS,
  MatrixClient,
  SubnetClient,
  SIGN_MESSAGE
};
