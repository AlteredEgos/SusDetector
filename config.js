'use strict';

const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const guildFields = new Set(['guildId', 'alertChannelId', 'roleId', 'mode', 'deleteWindowSeconds']);

function discordId(value, field) {
  if (typeof value !== 'string' || !/^[1-9]\d{16,19}$/.test(value)) {
    throw new Error(`${field} must be a Discord ID written as a string`);
  }
  return value;
}

function parseGuild(entry, field) {
  for (const key of Object.keys(entry)) {
    if (!guildFields.has(key)) throw new Error(`${field}.${key} is not a recognized setting`);
  }
  const guildId = discordId(entry.guildId, `${field}.guildId`);
  const alertChannelId = discordId(entry.alertChannelId, `${field}.alertChannelId`);
  const { mode = 'enforce', deleteWindowSeconds: seconds = 10 } = entry;
  if (mode !== 'enforce' && mode !== 'alert') throw new Error(`${field}.mode must be enforce or alert`);
  if (!Number.isInteger(seconds) || seconds < 1 || seconds > 120) {
    throw new Error(`${field}.deleteWindowSeconds must be an integer from 1 to 120`);
  }
  const roleId = mode === 'enforce' || entry.roleId != null ? discordId(entry.roleId, `${field}.roleId`) : null;
  return { guildId, alertChannelId, roleId, mode, windowMs: seconds * 1000 };
}

function parseGuilds(document) {
  if (!Array.isArray(document?.guilds) || document.guilds.length === 0) {
    throw new Error('The config must contain a nonempty guilds array');
  }
  const guilds = new Map();
  for (const [index, entry] of document.guilds.entries()) {
    const field = `guilds[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`${field} must be an object`);
    const config = parseGuild(entry, field);
    if (guilds.has(config.guildId)) throw new Error(`${field} repeats guild ID ${config.guildId}`);
    guilds.set(config.guildId, config);
  }
  return guilds;
}

function readConfig(env = process.env, directory = process.cwd()) {
  const token = env.DISCORD_TOKEN?.trim();
  if (!token) throw new Error('Set DISCORD_TOKEN to the bot token');

  const configuredPath = env.SUSDETECTOR_CONFIG?.trim();
  const path = resolve(directory, configuredPath || 'guilds.json');
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT' || configuredPath) throw error;
    if (!env.GUILD_ID?.trim()) throw new Error(`Copy guilds.example.json to ${path} and configure at least one server`);

    const mode = env.MODE?.trim();
    const legacy = {
      guildId: env.GUILD_ID.trim(),
      alertChannelId: env.ALERT_CHANNEL_ID?.trim(),
      roleId: mode === 'alert' ? undefined : env.SUSPECTED_BOT_ROLE_ID?.trim(),
      mode,
      deleteWindowSeconds: Number(env.DELETE_WINDOW_SECONDS ?? 10),
    };
    return { token, guilds: parseGuilds({ guilds: [legacy] }) };
  }

  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in ${path}: ${error.message}`);
  }
  return { token, guilds: parseGuilds(document) };
}

module.exports = { discordId, readConfig };
