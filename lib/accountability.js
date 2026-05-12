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
 * When a `delegation` envelope is passed, the signer is expected to be the
 * delegate key — the envelope is bundled into the return so verifiers can
 * recover the delegate's address from the per-message signatures and then
 * walk back to the delegator via the envelope's signature.
 *
 * @param {string|object} signerOrKey - Either a hex private key string, or any
 *   object that exposes an async `signMessage(text): Promise<string>` method
 *   (e.g. an `ethers.Wallet`, an `ethers.JsonRpcSigner` from MetaMask, or any
 *   custom signer wrapper).
 * @param {Array<{sender: string, body: string}>} history
 * @param {string} message
 * @param {string} sender
 * @param {object} [delegation] - Optional delegation envelope:
 *   `{ delegator, to, from, until, signature }`.
 * @returns {Promise<{message, prev_conv_sign, with_reply_sign, reply_only_sign, message_with_sign, delegation?}>}
 */
async function signMessage(signerOrKey, history, message, sender, delegation = null) {
  const signer =
    typeof signerOrKey === 'string'
      ? new ethers.Wallet(signerOrKey)
      : signerOrKey;
  if (!signer || typeof signer.signMessage !== 'function') {
    throw new Error('signMessage requires a hex private key or a signer with an async signMessage(text) method');
  }

  let prev_conv_sign = null;
  if (history.length > 0) {
    const prevTranscript = buildTranscript(history);
    prev_conv_sign = await signer.signMessage(prevTranscript);
  }

  const fullHistory = [...history, { sender, body: message }];
  const fullTranscript = buildTranscript(fullHistory);
  const with_reply_sign = await signer.signMessage(fullTranscript);

  const replyOnlyTranscript = formatLine(sender, message);
  const reply_only_sign = await signer.signMessage(replyOnlyTranscript);

  const trailerLines = [
    `Prev conv: ${prev_conv_sign || 'None'}`,
    `With reply: ${with_reply_sign}`,
    `Reply only: ${reply_only_sign}`,
  ];
  if (delegation) trailerLines.push(`Delegation: ${JSON.stringify(delegation)}`);
  const message_with_sign = [message, ...trailerLines].join('\n');

  const result = { message, prev_conv_sign, with_reply_sign, reply_only_sign, message_with_sign };
  if (delegation) result.delegation = delegation;
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
    if (m.delegation) lines.push(`Delegation: ${JSON.stringify(m.delegation)}`);
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
  // Each block ends with up to three optional trailer lines, in this fixed
  // order from the bottom up. We pop them off the end (most-specific first)
  // so a missing earlier trailer doesn't strand a later one. The "Prev conv"
  // sentinel "None" maps to null; the others pass through.
  const TRAILERS = [
    { field: 'delegation', re: /^Delegation: (.+)$/, transform: v => { try { return JSON.parse(v); } catch { return null; } } },
    { field: 'reply_only', re: /^Reply only: (.+)$/ },
    { field: 'with_reply', re: /^With reply: (.+)$/ },
    { field: 'prev_conv',  re: /^Prev conv: (.+)$/, transform: v => v === 'None' ? null : v },
  ];

  const blocks = text.split(/\n\n+/);
  return blocks.filter(b => b.trim()).map(block => {
    const lines = block.split('\n');
    const fields = { with_reply: null, prev_conv: null, reply_only: null, delegation: null };

    for (const { field, re, transform } of TRAILERS) {
      if (lines.length === 0) break;
      const m = lines[lines.length - 1].match(re);
      if (m) {
        fields[field] = transform ? transform(m[1]) : m[1];
        lines.pop();
      }
    }
    const { with_reply, prev_conv, reply_only, delegation } = fields;

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

    const parsed = { sender, body, prev_conv, with_reply, reply_only };
    if (delegation) parsed.delegation = delegation;
    return parsed;
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
