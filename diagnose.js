'use strict';

const { once } = require('node:events');
const { discordId, readConfig } = require('./config');
const { applyActions, checkRole, checkTimeout, fetchModerationState, roleLabel } = require('./guard');

const MANUAL_TEST_REASON = 'SusDetector manual moderation test';

async function main(args) {
  const apply = args[2] === '--apply';
  if (args.length !== (apply ? 3 : 2)) {
    throw new Error('Usage: npm run diagnose -- <server-id> <member-id> [--apply]');
  }
  const guildId = discordId(args[0], 'Server ID');
  const memberId = discordId(args[1], 'Member ID');
  const { token, guilds } = readConfig();
  const config = guilds.get(guildId);
  if (!config) throw new Error(`Server ${guildId} is missing from the SusDetector configuration`);
  if (apply && config.mode !== 'enforce') throw new Error('The apply test requires enforce mode for the selected server');

  const { Client, Events, GatewayIntentBits } = require('discord.js');
  const client = new Client({ intents: [GatewayIntentBits.Guilds] });
  try {
    const ready = once(client, Events.ClientReady, { signal: AbortSignal.timeout(30_000) });
    await Promise.all([ready, client.login(token)]);
    const guild = client.guilds.cache.get(guildId);
    if (!guild?.available) throw new Error(`SusDetector could not access server ${guildId}`);

    const { role, bot, member } = await fetchModerationState(guild, memberId, config.roleId);
    const configuredRole = role ? roleLabel(role) : config.roleId ? `Missing (${config.roleId})` : 'Unset';
    const yesNo = (value) => value ? 'yes' : 'no';

    console.log([
      `Server: ${guild.name} (${guild.id})`,
      `Mode: ${config.mode}`,
      `Member: ${member.user.username} (${member.id})`,
      `SusDetector’s highest role: ${roleLabel(bot.roles.highest)}`,
      `Member’s highest role: ${roleLabel(member.roles.highest)}`,
      `Member owns the server: ${yesNo(member.id === guild.ownerId)}`,
      `Member has Administrator: ${yesNo(member.permissions.has('Administrator'))}`,
      `SusDetector has Administrator: ${yesNo(bot.permissions.has('Administrator'))}`,
      `SusDetector has Manage Roles: ${yesNo(bot.permissions.has('ManageRoles'))}`,
      `SusDetector has Timeout Members: ${yesNo(bot.permissions.has('ModerateMembers'))}`,
      `Configured suspected role: ${configuredRole}`,
      `Role check: ${checkRole(member, role) ?? 'Eligible'}`,
      `Timeout check: ${checkTimeout(member) ?? 'Eligible'}`,
    ].join('\n'));

    if (apply) {
      if (member.user.bot) throw new Error('Select a human member for the apply test');
      const result = await applyActions(member, role, Date.now(), MANUAL_TEST_REASON);
      console.log(`Role result: ${result.role}\nTimeout result: ${result.timeout}`);
      for (const error of result.errors) {
        console.error([error.code, error.message].filter(Boolean).join(' '));
      }
      if (result.errors.length || result.role.startsWith('Blocked') || result.timeout.startsWith('Blocked')) {
        process.exitCode = 1;
      }
    }
  } finally {
    await client.destroy();
  }
}

main(process.argv.slice(2)).catch((error) => {
  if (error.code === 10007) console.error('Discord could not find that member in this server. Check their ID and current membership.');
  else if (error.name === 'AbortError') console.error('Timed out waiting for SusDetector to connect to Discord.');
  else console.error(error.message);
  process.exitCode = 1;
});
