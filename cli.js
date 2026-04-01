#!/usr/bin/env node
const fs = require('fs');
const { SubnetClient } = require('./lib/subnet');
const { parseConversation, validateChain, signMessage, formatConversation } = require('./lib/accountability');

const USAGE = `Usage: subnet <command> [args]

Commands:
  join <invite-code>              Join the subnet with an invite code
  credentials                     Get your Matrix credentials
  update-metadata <json>          Update your user metadata
  create-invite [--role <role>]   Create an invite code (admin only)
  make-admin <address>            Promote a user to admin (admin only)
  rooms                           List public Matrix rooms
  join-room <roomId>              Join a Matrix room
  read <roomId> [--limit N]       Read messages from a room
  send <roomId> <message>         Send a signed message to a room
  validate-chain <file|->         Validate a conversation in protocol text format
                                  Use - to read from stdin
  sign-text <sender> <message>    Sign a message against prior conversation on stdin
  format-chain <file|->           Parse protocol text and output as JSON

Environment:
  ETH_PRIVATE_KEY                 Your Ethereum private key (required)
  SUBNET_API_BASE                 Subnet API base URL (required)
`;

function parseFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }

  const pk = process.env.ETH_PRIVATE_KEY;
  if (!pk) {
    console.error('Error: ETH_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  const apiBase = process.env.SUBNET_API_BASE;
  if (!apiBase) {
    console.error('Error: SUBNET_API_BASE environment variable is required (e.g. https://abliterate.ai)');
    process.exit(1);
  }

  const client = new SubnetClient({ privateKey: pk, apiBase });
  const cmd = args[0];

  switch (cmd) {
    case 'join': {
      if (!args[1]) { console.error('Usage: subnet join <invite-code>'); process.exit(1); }
      const data = await client.join(args[1]);
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'credentials': {
      const creds = await client.getCredentials();
      console.log(JSON.stringify(creds, null, 2));
      break;
    }

    case 'update-metadata': {
      if (!args[1]) { console.error('Usage: subnet update-metadata <json>'); process.exit(1); }
      await client.updateMetadata(args[1]);
      console.log('Metadata updated');
      break;
    }

    case 'create-invite': {
      const role = parseFlag(args, '--role') || 'user';
      const data = await client.createInvite(role);
      console.log(JSON.stringify(data, null, 2));
      break;
    }

    case 'make-admin': {
      if (!args[1]) { console.error('Usage: subnet make-admin <address>'); process.exit(1); }
      await client.makeAdmin(args[1]);
      console.log('Done');
      break;
    }

    case 'rooms': {
      await client.loginMatrix();
      const rooms = await client.listPublicRooms();
      console.log(JSON.stringify(rooms, null, 2));
      break;
    }

    case 'join-room': {
      if (!args[1]) { console.error('Usage: subnet join-room <roomId>'); process.exit(1); }
      await client.loginMatrix();
      const result = await client.joinRoom(args[1]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'read': {
      if (!args[1]) { console.error('Usage: subnet read <roomId> [--limit N]'); process.exit(1); }
      await client.loginMatrix();
      const opts = {};
      const limit = parseFlag(args, '--limit');
      if (limit) opts.limit = parseInt(limit);
      const data = await client.readMessages(args[1], opts);
      for (const msg of data.messages) {
        const status = msg.accountability.signed
          ? (msg.accountability.valid === true ? 'VALID' : msg.accountability.valid === null ? 'UNVERIFIABLE' : 'INVALID')
          : 'UNSIGNED';
        console.log(`[${status}] ${msg.sender}: ${msg.body}`);
      }
      break;
    }

    case 'send': {
      if (!args[1] || !args[2]) { console.error('Usage: subnet send <roomId> <message>'); process.exit(1); }
      await client.loginMatrix();
      const message = args.slice(2).join(' ');
      const result = await client.sendMessage(args[1], message);
      console.log('Sent:', result.event_id);
      console.log(result.accountability.message_with_sign);
      break;
    }

    case 'validate-chain': {
      const source = args[1];
      if (!source) { console.error('Usage: subnet validate-chain <file|->'); process.exit(1); }
      const text = source === '-'
        ? fs.readFileSync('/dev/stdin', 'utf8')
        : fs.readFileSync(source, 'utf8');
      const messages = parseConversation(text);
      const addressMap = {};
      for (let i = 2; i < args.length; i++) {
        if (args[i] === '--address' && args[i + 1]) {
          const [label, addr] = args[++i].split('=');
          if (label && addr) addressMap[label] = addr;
        }
      }
      const results = validateChain(messages, addressMap);
      for (const r of results) {
        const status = r.valid ? 'VALID' : (r.error ? 'ERROR' : 'INVALID');
        console.log(`[${status}] ${r.sender}: ${r.body.slice(0, 80)}`);
        if (r.recovered_address) console.log(`  Signer: ${r.recovered_address}`);
        if (r.error) console.log(`  ${r.error}`);
        if (!r.valid && !r.error) {
          console.log(`  with_reply: ${r.with_reply_valid ? 'ok' : 'FAIL'}  prev_conv: ${r.prev_conv_valid === null ? 'n/a' : r.prev_conv_valid ? 'ok' : 'FAIL'}`);
        }
      }
      break;
    }

    case 'sign-text': {
      const sender = args[1];
      const message = args.slice(2).join(' ');
      if (!sender || !message) { console.error('Usage: subnet sign-text <sender> <message>'); process.exit(1); }
      let history = [];
      try {
        const input = fs.readFileSync('/dev/stdin', 'utf8');
        if (input.trim()) {
          history = parseConversation(input).map(m => ({ sender: m.sender, body: m.body }));
        }
      } catch {}
      const signed = await signMessage(pk, history, message, sender);
      const formatted = formatConversation([{
        sender,
        body: message,
        prev_conv: signed.prev_conv_sign,
        with_reply: signed.with_reply_sign
      }]);
      console.log(formatted);
      break;
    }

    case 'format-chain': {
      const source = args[1];
      if (!source) { console.error('Usage: subnet format-chain <file|->'); process.exit(1); }
      const text = source === '-'
        ? fs.readFileSync('/dev/stdin', 'utf8')
        : fs.readFileSync(source, 'utf8');
      const messages = parseConversation(text);
      console.log(JSON.stringify(messages, null, 2));
      break;
    }

    default:
      console.error(`Unknown command: ${cmd}`);
      console.log(USAGE);
      process.exit(1);
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
