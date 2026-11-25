'use strict';

const { setTimeout: delay } = require('node:timers/promises');
const {
  AuditLogEvent, ChannelType, Client, Events, GatewayIntentBits, GuildSystemChannelFlags,
  MessageType, Partials, PermissionFlagsBits, Routes,
} = require('discord.js');
const { readConfig } = require('./config');
const { AUDIT_LIMIT, applyActions, auditResult, fetchModerationState, isWelcomeForMembership } = require('./guard');
const { watchGuilds } = require('./monitor');
const { version } = require('./package.json');

const AUDIT_GRACE_MS = 3000;
const UNKNOWN_MEMBER = 10007;

function discordError(error) {
  return [error.code, error.message].filter(Boolean).join(' ');
}

async function validateSetup(guild, config) {
  const [me, alertChannel, role] = await Promise.all([
    guild.members.fetchMe(),
    guild.channels.fetch(config.alertChannelId),
    config.mode === 'enforce' ? guild.roles.fetch(config.roleId) : null,
  ]);
  const alertTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];
  if (alertChannel?.guildId !== guild.id || !alertTypes.includes(alertChannel.type) ||
      !alertChannel.permissionsFor(me)?.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages])) {
    throw new Error('The alert channel must be a text or announcement channel in this server that the bot can view and post in');
  }
  const welcomeChannel = guild.systemChannel;
  if (!welcomeChannel?.permissionsFor(me)?.has(PermissionFlagsBits.ViewChannel) ||
      guild.systemChannelFlags.has(GuildSystemChannelFlags.SuppressJoinNotifications)) {
    throw new Error('Enable native Discord welcome messages in a System Messages Channel the bot can view');
  }
  const needed = [PermissionFlagsBits.ViewAuditLog, PermissionFlagsBits.ManageRoles, PermissionFlagsBits.ModerateMembers];
  if (config.mode === 'enforce' && !me.permissions.has(needed)) {
    throw new Error('Enforce mode requires View Audit Log, Manage Roles, and Moderate Members');
  }
  if (config.mode === 'enforce' && (!role?.editable || role.managed || role.id === guild.id)) {
    throw new Error('Use an assignable suspected bot role below the bot’s highest role');
  }
}

async function inspectAuditLog(guild, welcome) {
  try {
    const response = await guild.client.rest.get(Routes.guildAuditLog(guild.id), {
      query: new URLSearchParams({ action_type: String(AuditLogEvent.MessageDelete), limit: String(AUDIT_LIMIT) }),
    });
    return auditResult(response.audit_log_entries, welcome);
  } catch (error) {
    console.warn(`[${guild.id}] Audit log unavailable for ${welcome.id}. ${discordError(error)}`);
    return 'inconclusive';
  }
}

async function handleDeletion(guild, welcome, config, isActive) {
  await delay(AUDIT_GRACE_MS, undefined, { ref: false });
  if (!isActive()) return;
  const evidence = await inspectAuditLog(guild, welcome);
  if (!isActive()) return;
  if (evidence === 'moderator') {
    console.info(`[${guild.id}] Skipped ${welcome.id} because a matching moderator deletion was found`);
    return;
  }

  let member;
  let role;
  let refreshFailed = false;
  const enforce = evidence === 'no-match' && config.mode === 'enforce';
  try {
    if (enforce) {
      ({ member, role } = await fetchModerationState(guild, welcome.memberId, config.roleId));
    } else {
      member = await guild.members.fetch({ user: welcome.memberId, force: true });
    }
  } catch (error) {
    if (error.code !== UNKNOWN_MEMBER) {
      refreshFailed = enforce;
      const lookup = enforce ? 'Moderation state refresh' : 'Member lookup';
      console.warn(`[${guild.id}] ${lookup} failed for ${welcome.memberId}. ${discordError(error)}`);
    }
  }

  if (!isActive()) return;
  let result = { timeout: 'Skipped', role: 'Skipped', errors: [] };
  let decision = 'No matching moderator deletion found. Possible self-deletion.';
  const confirmed = isWelcomeForMembership(welcome, member);
  if (evidence === 'inconclusive') {
    decision = 'Audit log inconclusive. Automatic moderation skipped.';
  } else if (refreshFailed) {
    decision += ' Discord permission refresh failed. Automatic moderation skipped.';
  } else if (!confirmed) {
    decision += ' The original membership could not be confirmed.';
  } else if (config.mode === 'alert') {
    decision += ' Alert-only mode.';
  } else {
    result = await applyActions(member, role);
  }

  for (const error of result.errors) {
    console.error(`[${guild.id}] Moderation failed for ${welcome.memberId}. ${discordError(error)}`);
  }
  const content = [
    '**Welcome message deleted**',
    `Member <@${welcome.memberId}> (\`${welcome.memberId}\`)`,
    `Message \`${welcome.id}\` in <#${welcome.channelId}> disappeared after ${(welcome.elapsedMs / 1000).toFixed(1)}s.`,
    decision,
    `Role — ${result.role}`,
    `Timeout — ${result.timeout}`,
  ].join('\n');
  console.info(`[${guild.id}] ${welcome.id} / ${welcome.memberId}. ${decision} Role: ${result.role}. Timeout: ${result.timeout}.`);
  const channel = await guild.channels.fetch(config.alertChannelId);
  if (channel?.guildId !== guild.id || !channel.isSendable()) {
    throw new Error('The configured moderator alert channel in this server is unavailable');
  }
  await channel.send({ content, allowedMentions: { parse: [] }, nonce: welcome.id, enforceNonce: true });
}

async function main() {
  const config = readConfig();
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
    partials: [Partials.Message],
  });
  const stopMonitoring = watchGuilds(client, { Events, MessageType }, config.guilds, { validateSetup, handleDeletion });

  function stop() {
    stopMonitoring();
    client.destroy();
  }

  client.on(Events.Error, (error) => console.error(discordError(error)));
  client.once(Events.ClientReady, () => console.info(`SusDetector v${version} connected as ${client.user.tag}.`));
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try {
    await client.login(config.token);
  } catch (error) {
    stop();
    throw error;
  }
}

main().catch((error) => {
  console.error(discordError(error));
  process.exitCode = 1;
});
