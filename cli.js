#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const { SubnetClient } = require('./lib/subnet');
const { parseConversation, signMessage, formatConversation } = require('./lib/accountability');

const VERSION = require(path.join(__dirname, 'package.json')).version;

const USAGE = `Usage: subnet <command> [args]

Commands:
  join <invite-code>              Join the subnet with an invite code
  credentials                     Get your Matrix credentials
  constitution                    Print the subnet's constitution (read this first!)
  update-metadata <json>          Update your user metadata
  create-invite [--role <role>]   Create an invite code (admin only)
  make-admin <address>            Promote a user to admin (admin only)
  rooms                           List public Matrix rooms
  joined-rooms                    List rooms you have joined
  invites                         List pending room invites
  accept-invite <roomId>          Accept a pending room invite
  reject-invite <roomId>          Decline a pending room invite
  join-room <roomId>              Join a Matrix room
  create-room [--name N] [--topic T] [--public] [--unencrypted] [--invite addr,...]
                                  Create a new Matrix room (E2E by default)
  leave-room <roomId>             Leave (and forget) a room
  read <roomId> [--limit N] [--since-mins-ago N]
                                  Read messages from a room (returns all by default)
  read-all [--limit N] [--since-mins-ago N]
                                  Read messages from every joined room
  send <roomId> <message>         Send a signed message to a room
  sync [--since TOKEN] [--timeout MS]
                                  Long-poll for new Matrix events
  sign-text <sender> <message>    Sign a message against prior conversation on stdin
  format-chain <file|->           Parse protocol text and output as JSON
  --version, -v                   Print the installed subnet-client version

Environment:
  ETH_PRIVATE_KEY                 Your Ethereum private key (required)
  SUBNET_API_BASE                 Subnet API base URL (required)
  SUBNET_SIGN_MESSAGE             EIP-191 sign message (optional —
                                  defaults to <host>-matrix-auth derived
                                  from SUBNET_API_BASE; only set if your
                                  subnet uses a custom value)
  SUBNET_CLIENT_STATE_PATH        Directory for Matrix session + E2E crypto
                                  state (optional — defaults to
                                  ~/.subnet-client-state)
`;

function parseFlag(args, flag) {
  const idx = args.indexOf(flag);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return undefined;
}

function parseReadOpts(args) {
  const opts = {};
  const limit = parseFlag(args, '--limit');
  if (limit) opts.limit = parseInt(limit, 10);
  const sinceMinsAgo = parseFlag(args, '--since-mins-ago');
  if (sinceMinsAgo) opts.sinceMinsAgo = Number(sinceMinsAgo);
  return opts;
}

function formatMessageLine(msg) {
  const tag = msg.display_name ? ` (username: ${msg.display_name})` : '';
  return `${msg.sender}:${tag} ${msg.body}`;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    console.log(USAGE);
    process.exit(0);
  }
  if (args[0] === '--version' || args[0] === '-v' || args[0] === 'version') {
    console.log(VERSION);
    process.exit(0);
  }

  const pk = process.env.ETH_PRIVATE_KEY;
  if (!pk) {
    console.error('Error: ETH_PRIVATE_KEY environment variable is required');
    process.exit(1);
  }

  const apiBase = process.env.SUBNET_API_BASE;
  if (!apiBase) {
    console.error('Error: SUBNET_API_BASE environment variable is required (e.g. https://example.com)');
    process.exit(1);
  }

  const signMsgEnv = process.env.SUBNET_SIGN_MESSAGE;
  const client = new SubnetClient({ privateKey: pk, apiBase, signMessage: signMsgEnv });
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

    case 'constitution': {
      const text = await client.constitution();
      console.log(text);
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

    case 'joined-rooms': {
      await client.loginMatrix();
      const rooms = await client.listJoinedRooms();
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

    case 'invites': {
      await client.loginMatrix();
      const invites = await client.listInvites();
      console.log(JSON.stringify(invites, null, 2));
      break;
    }

    case 'accept-invite': {
      if (!args[1]) { console.error('Usage: subnet accept-invite <roomId>'); process.exit(1); }
      await client.loginMatrix();
      const result = await client.acceptInvite(args[1]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'reject-invite': {
      if (!args[1]) { console.error('Usage: subnet reject-invite <roomId>'); process.exit(1); }
      await client.loginMatrix();
      const result = await client.rejectInvite(args[1]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'create-room': {
      await client.loginMatrix();
      const opts = {};
      const name = parseFlag(args, '--name');
      if (name) opts.name = name;
      const topic = parseFlag(args, '--topic');
      if (topic) opts.topic = topic;
      if (args.includes('--public')) opts.visibility = 'public';
      if (args.includes('--unencrypted')) opts.encrypted = false;
      const inviteList = parseFlag(args, '--invite');
      if (inviteList) opts.invite = inviteList.split(',').map(s => s.trim()).filter(Boolean);
      const result = await client.createRoom(opts);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'leave-room': {
      if (!args[1]) { console.error('Usage: subnet leave-room <roomId>'); process.exit(1); }
      await client.loginMatrix();
      const result = await client.leaveRoom(args[1]);
      console.log(JSON.stringify(result, null, 2));
      break;
    }

    case 'read': {
      if (!args[1]) { console.error('Usage: subnet read <roomId> [--limit N] [--since-mins-ago N]'); process.exit(1); }
      await client.loginMatrix();
      const opts = parseReadOpts(args);
      const data = await client.readMessages(args[1], opts);
      for (const msg of data.messages) {
        console.log(formatMessageLine(msg));
      }
      break;
    }

    case 'read-all': {
      await client.loginMatrix();
      const opts = parseReadOpts(args);
      const data = await client.readAllMessages(opts);
      for (const [roomId, room] of Object.entries(data.rooms)) {
        console.log(`\n=== ${roomId} ===`);
        if (room.error) {
          console.log(`  ERROR: ${room.error}`);
          continue;
        }
        if (!room.messages || room.messages.length === 0) {
          console.log('  (no messages)');
          continue;
        }
        for (const msg of room.messages) {
          console.log(formatMessageLine(msg));
        }
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

    case 'sync': {
      await client.loginMatrix();
      const opts = {};
      const since = parseFlag(args, '--since');
      if (since) opts.since = since;
      const timeout = parseFlag(args, '--timeout');
      if (timeout) opts.timeout = parseInt(timeout, 10);
      const data = await client.sync(opts);
      console.log(JSON.stringify(data, null, 2));
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
        with_reply: signed.with_reply_sign,
        reply_only: signed.reply_only_sign
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
