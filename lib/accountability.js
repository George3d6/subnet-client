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
 * Produces three EIP-191 signatures:
 *   - prev_conv_sign:  signature over the transcript of all prior messages
 *                      (null if there are no prior messages)
 *   - with_reply_sign: signature over the transcript including the new message
 *   - reply_only_sign: signature over just the new message line on its own
 *
 * @param {string} privateKey
 * @param {Array<{sender: string, body: string}>} history
 * @param {string} message
 * @param {string} sender
 * @returns {Promise<{message, prev_conv_sign, with_reply_sign, reply_only_sign, message_with_sign}>}
 */
async function signMessage(privateKey, history, message, sender) {
  const wallet = new ethers.Wallet(privateKey);

  let prev_conv_sign = null;
  if (history.length > 0) {
    const prevTranscript = buildTranscript(history);
    prev_conv_sign = await wallet.signMessage(prevTranscript);
  }

  const fullHistory = [...history, { sender, body: message }];
  const fullTranscript = buildTranscript(fullHistory);
  const with_reply_sign = await wallet.signMessage(fullTranscript);

  const replyOnlyTranscript = formatLine(sender, message);
  const reply_only_sign = await wallet.signMessage(replyOnlyTranscript);

  const message_with_sign = [
    message,
    `Prev conv: ${prev_conv_sign || 'None'}`,
    `With reply: ${with_reply_sign}`,
    `Reply only: ${reply_only_sign}`
  ].join('\n');

  return { message, prev_conv_sign, with_reply_sign, reply_only_sign, message_with_sign };
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
 * @param {Array<{sender: string, body: string, prev_conv: string|null, with_reply: string, reply_only?: string}>} messages
 * @returns {string}
 */
function formatConversation(messages) {
  return messages.map(m => {
    const lines = [`${m.sender}: `];
    lines.push(m.body);
    lines.push(`Prev conv: ${m.prev_conv || 'None'}`);
    lines.push(`With reply: ${m.with_reply}`);
    if (m.reply_only) lines.push(`Reply only: ${m.reply_only}`);
    return lines.join('\n');
  }).join('\n\n');
}

/**
 * Parse protocol text format into structured messages.
 *
 * @param {string} text
 * @returns {Array<{sender: string, body: string, prev_conv: string|null, with_reply: string, reply_only: string|null}>}
 */
function parseConversation(text) {
  const blocks = text.split(/\n\n+/);
  return blocks.filter(b => b.trim()).map(block => {
    const lines = block.split('\n');

    let with_reply = null;
    let prev_conv = null;
    let reply_only = null;

    if (lines.length >= 1) {
      const lastLine = lines[lines.length - 1];
      const roMatch = lastLine.match(/^Reply only: (.+)$/);
      if (roMatch) {
        reply_only = roMatch[1];
        lines.pop();
      }
    }

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

    return { sender, body, prev_conv, with_reply, reply_only };
  });
}

module.exports = {
  signMessage,
  buildTranscript,
  formatLine,
  addressFromUserId,
  addressFromDisplayName,
  formatConversation,
  parseConversation,
  MAX_HISTORY_CHARS
};
