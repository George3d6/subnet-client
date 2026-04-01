const { ethers } = require('ethers');

const MAX_HISTORY_CHARS = 1_000_000;

/**
 * Format a single message line for the accountability transcript.
 * Newlines within the message body are replaced with spaces.
 */
function formatLine(sender, body) {
  return `${sender}: ${body.replace(/\n/g, ' ')}`;
}

/**
 * Build a transcript string from an array of messages.
 * Each message: { sender: string, body: string }
 * Truncates to the last 1M characters per protocol spec.
 */
function buildTranscript(messages) {
  const transcript = messages.map(m => formatLine(m.sender, m.body)).join('\n');
  if (transcript.length > MAX_HISTORY_CHARS) {
    return transcript.slice(-MAX_HISTORY_CHARS);
  }
  return transcript;
}

/**
 * Sign a message within a conversation context.
 *
 * @param {string} privateKey - Ethereum private key (hex, with or without 0x prefix)
 * @param {Array<{sender: string, body: string}>} history - All prior messages in the conversation
 * @param {string} message - The new message text
 * @param {string} sender - Sender identifier for the new message (e.g. Matrix user ID)
 * @returns {Promise<{message, prev_conv_sign, with_reply_sign, message_with_sign}>}
 */
async function signMessage(privateKey, history, message, sender) {
  const wallet = new ethers.Wallet(privateKey);

  // prev_conv: sign all prior messages, null if this is the first message
  let prev_conv_sign = null;
  if (history.length > 0) {
    const prevTranscript = buildTranscript(history);
    prev_conv_sign = await wallet.signMessage(prevTranscript);
  }

  // with_reply: sign all messages including the new one
  const fullHistory = [...history, { sender, body: message }];
  const fullTranscript = buildTranscript(fullHistory);
  const with_reply_sign = await wallet.signMessage(fullTranscript);

  const message_with_sign = [
    message,
    `Prev conv: ${prev_conv_sign || 'None'}`,
    `With reply: ${with_reply_sign}`
  ].join('\n');

  return { message, prev_conv_sign, with_reply_sign, message_with_sign };
}

/**
 * Validate that a message was signed by the claimed sender.
 *
 * @param {string} expectedAddress - Ethereum address of the claimed sender
 * @param {Array<{sender: string, body: string}>} history - Messages before this one
 * @param {{sender: string, body: string}} message - The message to validate
 * @param {{prev_conv: string|null, with_reply: string}} accountability - Signature data
 * @returns {{valid: boolean, recovered_address: string|null, with_reply_valid: boolean, prev_conv_valid: boolean|null, error?: string}}
 */
function validateSender(expectedAddress, history, message, accountability) {
  const result = {
    valid: false,
    recovered_address: null,
    with_reply_valid: false,
    prev_conv_valid: null
  };

  try {
    // Validate with_reply — signature over full transcript including this message
    const fullHistory = [...history, message];
    const fullTranscript = buildTranscript(fullHistory);
    const recovered = ethers.verifyMessage(fullTranscript, accountability.with_reply);
    result.recovered_address = recovered;
    result.with_reply_valid = recovered.toLowerCase() === expectedAddress.toLowerCase();

    // Validate prev_conv
    if (accountability.prev_conv === null || accountability.prev_conv === undefined) {
      // null is only valid when there are no prior messages
      result.prev_conv_valid = history.length === 0;
    } else {
      const prevTranscript = buildTranscript(history);
      const prevRecovered = ethers.verifyMessage(prevTranscript, accountability.prev_conv);
      result.prev_conv_valid = prevRecovered.toLowerCase() === expectedAddress.toLowerCase();
    }

    result.valid = result.with_reply_valid && result.prev_conv_valid !== false;
  } catch (err) {
    result.error = err.message;
  }

  return result;
}

/**
 * Extract an Ethereum address from a Matrix user ID.
 * "@0xAbCdEf1234...:matrix.example.com" → "0xAbCdEf1234..."
 */
function addressFromUserId(userId) {
  const match = userId.match(/^@(0x[0-9a-fA-F]+):/);
  return match ? match[1] : null;
}

/**
 * Extract an Ethereum address from a Matrix display name.
 * Display names follow the format "<name> - <address>"
 */
function addressFromDisplayName(display_name) {
  const match = display_name.match(/(0x[0-9a-fA-F]+)$/);
  return match ? match[1] : null;
}

/**
 * Format a conversation as protocol text.
 *
 * @param {Array<{sender: string, body: string, prev_conv: string|null, with_reply: string}>} messages
 * @returns {string}
 */
function formatConversation(messages) {
  return messages.map(m => {
    const lines = [`${m.sender}: `];
    lines.push(m.body);
    lines.push(`Prev conv: ${m.prev_conv || 'None'}`);
    lines.push(`With reply: ${m.with_reply}`);
    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Parse protocol text format into structured messages.
 *
 * @param {string} text
 * @returns {Array<{sender: string, body: string, prev_conv: string|null, with_reply: string}>}
 */
function parseConversation(text) {
  const blocks = text.split(/\n\n+/);
  return blocks.filter(b => b.trim()).map(block => {
    const lines = block.split('\n');

    let with_reply = null;
    let prev_conv = null;

    if (lines.length >= 1) {
      const lastLine = lines[lines.length - 1];
      const wrMatch = lastLine.match(/^With reply: (.+)$/);
      if (wrMatch) {
        with_reply = wrMatch[1];
        lines.pop();
      }
    }

    if (lines.length >= 1) {
      const prevLine = lines[lines.length - 1];
      const pcMatch = prevLine.match(/^Prev conv: (.+)$/);
      if (pcMatch) {
        prev_conv = pcMatch[1] === 'None' ? null : pcMatch[1];
        lines.pop();
      }
    }

    let sender = '';
    let firstLineRemainder = '';
    if (lines.length >= 1) {
      const colonIdx = lines[0].indexOf(': ');
      if (colonIdx !== -1) {
        sender = lines[0].slice(0, colonIdx);
        firstLineRemainder = lines[0].slice(colonIdx + 2).trim();
      } else if (lines[0].endsWith(':')) {
        sender = lines[0].slice(0, -1);
      } else {
        sender = lines[0];
      }
      lines.shift();
    }

    const bodyParts = [];
    if (firstLineRemainder) bodyParts.push(firstLineRemainder);
    bodyParts.push(...lines);
    const body = bodyParts.join('\n');

    return { sender, body, prev_conv, with_reply };
  });
}

/**
 * Validate an entire chain of signed messages.
 *
 * @param {Array<{sender: string, body: string, prev_conv: string|null, with_reply: string}>} messages
 * @param {Object<string, string>} [addressMap] - Maps sender labels to Ethereum addresses.
 * @returns {Array<{index, sender, body, address, valid, with_reply_valid, prev_conv_valid, recovered_address, error?}>}
 */
function validateChain(messages, addressMap = {}) {
  const history = [];

  return messages.map((msg, i) => {
    const address = addressMap[msg.sender]
      || addressFromUserId(msg.sender)
      || (msg.sender.match(/^0x[0-9a-fA-F]{40}$/) ? msg.sender : null);

    const entry = {
      index: i,
      sender: msg.sender,
      body: msg.body,
      address,
      valid: false,
      with_reply_valid: false,
      prev_conv_valid: null,
      recovered_address: null
    };

    if (!msg.with_reply) {
      entry.error = 'Missing with_reply signature';
      history.push({ sender: msg.sender, body: msg.body });
      return entry;
    }

    if (!address) {
      try {
        const fullTranscript = buildTranscript([...history, { sender: msg.sender, body: msg.body }]);
        entry.recovered_address = ethers.verifyMessage(fullTranscript, msg.with_reply);
      } catch {}
      entry.error = 'No address mapping for sender — use addressMap to provide one';
      history.push({ sender: msg.sender, body: msg.body });
      return entry;
    }

    const validation = validateSender(
      address,
      history,
      { sender: msg.sender, body: msg.body },
      { prev_conv: msg.prev_conv, with_reply: msg.with_reply }
    );

    entry.valid = validation.valid;
    entry.with_reply_valid = validation.with_reply_valid;
    entry.prev_conv_valid = validation.prev_conv_valid;
    entry.recovered_address = validation.recovered_address;
    if (validation.error) entry.error = validation.error;

    history.push({ sender: msg.sender, body: msg.body });
    return entry;
  });
}

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
  MAX_HISTORY_CHARS
};
