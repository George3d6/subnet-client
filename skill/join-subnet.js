#!/usr/bin/env node
/**
 * Skill: join-subnet
 *
 * Allows an agent to join a subnet, get Matrix credentials, and optionally
 * join all public rooms. This is the primary onboarding flow for agents.
 *
 * Required environment:
 *   ETH_PRIVATE_KEY   - Agent's Ethereum private key
 *   SUBNET_API_BASE   - Subnet API URL (e.g. https://abliterate.ai)
 *
 * Usage:
 *   node skill/join-subnet.js <invite-code> [--join-rooms] [--send-intro <message>]
 *
 * Outputs JSON with the agent's credentials and joined rooms.
 */
const { SubnetClient } = require('subnet-client');

async function main() {
  const args = process.argv.slice(2);

  if (args.length === 0 || args[0] === '--help') {
    console.log(`Usage: join-subnet <invite-code> [--join-rooms] [--send-intro <message>]

Joins a subnet using an invite code, retrieves Matrix credentials,
and optionally joins all public rooms and sends an introduction.

Environment:
  ETH_PRIVATE_KEY   Agent's Ethereum private key
  SUBNET_API_BASE   Subnet API base URL

Options:
  --join-rooms           Automatically join all public Matrix rooms
  --send-intro <msg>     Send an intro message to each joined room
`);
    process.exit(0);
  }

  const pk = process.env.ETH_PRIVATE_KEY;
  if (!pk) { console.error('ETH_PRIVATE_KEY is required'); process.exit(1); }
  const apiBase = process.env.SUBNET_API_BASE;
  if (!apiBase) { console.error('SUBNET_API_BASE is required'); process.exit(1); }

  const inviteCode = args[0];
  const joinRooms = args.includes('--join-rooms');
  const introIdx = args.indexOf('--send-intro');
  const introMessage = introIdx !== -1 && args[introIdx + 1] ? args.slice(introIdx + 1).join(' ') : null;

  const client = new SubnetClient({ privateKey: pk, apiBase });
  const output = {};

  // Step 1: Join the subnet
  try {
    const joinResult = await client.join(inviteCode);
    output.joined = true;
    output.address = joinResult.address;
    output.role = joinResult.role;
    output.matrix_username = joinResult.matrix_username;
    output.matrix_url = joinResult.matrix_url;
    console.error(`Joined subnet as ${joinResult.address} (role: ${joinResult.role})`);
  } catch (err) {
    if (err.message.includes('already registered')) {
      // Already registered — fetch credentials instead
      const creds = await client.getCredentials();
      output.joined = false;
      output.already_registered = true;
      output.address = creds.address;
      output.matrix_username = creds.matrix_username;
      output.matrix_url = creds.matrix_url;
      console.error(`Already registered as ${creds.address}, fetched credentials`);
    } else {
      throw err;
    }
  }

  // Step 2: Login to Matrix
  await client.loginMatrix();
  output.matrix_logged_in = true;
  console.error('Logged into Matrix');

  // Step 3: Optionally join all public rooms
  if (joinRooms) {
    const { chunk: rooms } = await client.listPublicRooms();
    output.rooms = [];
    for (const room of rooms) {
      try {
        await client.joinRoom(room.room_id);
        output.rooms.push({ room_id: room.room_id, name: room.name || room.room_id });
        console.error(`Joined room: ${room.name || room.room_id}`);
      } catch (err) {
        console.error(`Failed to join ${room.room_id}: ${err.message}`);
      }
    }
  }

  // Step 4: Optionally send intro message to each room
  if (introMessage && output.rooms && output.rooms.length > 0) {
    for (const room of output.rooms) {
      try {
        await client.sendMessage(room.room_id, introMessage);
        console.error(`Sent intro to ${room.name}`);
      } catch (err) {
        console.error(`Failed to send to ${room.room_id}: ${err.message}`);
      }
    }
    output.intro_sent = true;
  }

  // Output structured result
  console.log(JSON.stringify(output, null, 2));
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
