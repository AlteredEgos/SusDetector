'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const test = require('node:test');
const { readConfig } = require('./config');
const example = require('./guilds.example.json');
const { watchGuilds } = require('./monitor');

function tempDirectory(t) {
  const directory = mkdtempSync(join(tmpdir(), 'susdetector-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}

test('loads multiple guilds from a custom path with separate settings', (t) => {
  const directory = tempDirectory(t);
  mkdirSync(join(directory, 'conf'));
  writeFileSync(join(directory, 'conf', 'guilds.json'), JSON.stringify(example));
  const [first, second] = example.guilds;
  const config = readConfig({ DISCORD_TOKEN: 'test', SUSDETECTOR_CONFIG: './conf/guilds.json', MODE: 'alert' }, directory);
  assert.equal(config.token, 'test');
  assert.deepEqual([...config.guilds.values()], [
    { guildId: first.guildId, alertChannelId: first.alertChannelId, roleId: first.roleId, windowMs: 10_000, mode: 'enforce' },
    { guildId: second.guildId, alertChannelId: second.alertChannelId, roleId: null, windowMs: 10_000, mode: 'alert' },
  ]);
});

test('keeps the legacy environment configuration when no guilds file exists', (t) => {
  const directory = tempDirectory(t);
  const entry = example.guilds[0];
  const env = {
    DISCORD_TOKEN: 'test', GUILD_ID: entry.guildId, ALERT_CHANNEL_ID: entry.alertChannelId,
    SUSPECTED_BOT_ROLE_ID: entry.roleId, DELETE_WINDOW_SECONDS: '20',
  };
  assert.deepEqual(readConfig(env, directory).guilds.get(entry.guildId), {
    guildId: entry.guildId, alertChannelId: entry.alertChannelId, roleId: entry.roleId, windowMs: 20_000, mode: 'enforce',
  });
  assert.throws(() => readConfig({ ...env, SUSDETECTOR_CONFIG: 'missing.json' }, directory), { code: 'ENOENT' });
});

test('rejects duplicates, numeric snowflakes, and misspelled mode settings', (t) => {
  const directory = tempDirectory(t);
  const path = join(directory, 'guilds.json');
  const env = { DISCORD_TOKEN: 'test' };
  const entry = example.guilds[0];
  writeFileSync(path, JSON.stringify({ guilds: [entry, entry] }));
  assert.throws(() => readConfig(env, directory), /repeats guild ID/);
  writeFileSync(path, JSON.stringify({ guilds: [{ ...entry, guildId: Number(entry.guildId) }] }));
  assert.throws(() => readConfig(env, directory), /guildId must be a Discord ID written as a string/);
  writeFileSync(path, JSON.stringify({ guilds: [{ ...entry, mdoe: 'alert' }] }));
  assert.throws(() => readConfig(env, directory), /mdoe is not a recognized setting/);
});

const events = {
  ClientReady: 'ready', GuildCreate: 'guildCreate', GuildAvailable: 'guildAvailable',
  GuildUnavailable: 'guildUnavailable', GuildDelete: 'guildDelete',
  MessageCreate: 'messageCreate', MessageDelete: 'messageDelete',
};
const discord = { Events: events, MessageType: { UserJoin: 7 } };

function makeGuild(id) {
  return { id, name: id, available: true, systemChannelId: `${id}-welcome` };
}

function welcome(guild, id = `${guild.id}-message`, createdTimestamp = Date.now()) {
  return {
    id, createdTimestamp, guild, guildId: guild.id, channelId: guild.systemChannelId,
    type: discord.MessageType.UserJoin, author: { id: 'new-member', bot: false },
  };
}

function watch(t, guilds, configs, validateSetup = async () => {}) {
  const client = new EventEmitter();
  client.guilds = { cache: new Map(guilds.map(guild => [guild.id, guild])) };
  const handled = [];
  const errors = [];
  const stop = watchGuilds(client, discord, configs, {
    validateSetup,
    handleDeletion: async (guild, message, config, isActive) => handled.push({ guild, message, config, isActive }),
    logger: { info() {}, warn() {}, error: error => errors.push(error) },
  });
  t.after(stop);
  client.emit(events.ClientReady);
  return { client, handled, errors };
}

test('routes two servers independently and ignores unconfigured servers', async (t) => {
  const first = makeGuild('first');
  const second = makeGuild('second');
  const ignored = makeGuild('ignored');
  const firstConfig = { alertChannelId: 'first-alert', roleId: 'first-role', mode: 'enforce', windowMs: 1000 };
  const secondConfig = { alertChannelId: 'second-alert', roleId: null, mode: 'alert', windowMs: 10_000 };
  const { client, handled } = watch(t, [first, second, ignored], new Map([[first.id, firstConfig], [second.id, secondConfig]]));
  await Promise.resolve();

  for (const message of [welcome(first), welcome(second), welcome(ignored)]) {
    client.emit(events.MessageCreate, message);
    client.emit(events.MessageDelete, message);
  }

  const oldTimestamp = Date.now() - 5000;
  for (const message of [welcome(first, 'first-older', oldTimestamp), welcome(second, 'second-older', oldTimestamp)]) {
    client.emit(events.MessageCreate, message);
    client.emit(events.MessageDelete, message);
  }

  assert.deepEqual(handled.map(({ guild, config }) => [guild.id, config]), [
    [first.id, firstConfig], [second.id, secondConfig], [second.id, secondConfig],
  ]);
});

test('leaves healthy servers active when another fails setup and starts later installs', async (t) => {
  const broken = makeGuild('broken');
  const healthy = makeGuild('healthy');
  const later = makeGuild('later');
  const config = { mode: 'alert', windowMs: 10_000 };
  const configs = new Map([[broken.id, config], [healthy.id, config], [later.id, config]]);
  const { client, handled, errors } = watch(t, [broken, healthy], configs, async (guild) => {
    if (guild === broken) throw new Error('Missing permissions');
  });
  await Promise.resolve();
  client.emit(events.GuildCreate, later);
  await Promise.resolve();

  for (const guild of [broken, healthy, later]) {
    const message = welcome(guild);
    client.emit(events.MessageCreate, message);
    client.emit(events.MessageDelete, message);
  }

  assert.deepEqual(handled.map(({ guild }) => guild.id), [healthy.id, later.id]);
  assert.equal(errors.length, 1);
  assert.match(errors[0], /\[broken\].*Missing permissions/);
});

test('drops pending deletions when a server goes unavailable and resumes with fresh state', async (t) => {
  const guild = makeGuild('server');
  const config = { mode: 'alert', windowMs: 10_000 };
  const { client, handled } = watch(t, [guild], new Map([[guild.id, config]]));
  await Promise.resolve();

  const pending = welcome(guild, 'pending');
  const old = welcome(guild, 'old');
  client.emit(events.MessageCreate, pending);
  client.emit(events.MessageCreate, old);
  client.emit(events.MessageDelete, pending);
  assert.equal(handled[0].isActive(), true);
  client.emit(events.GuildUnavailable, guild);
  assert.equal(handled[0].isActive(), false);
  client.emit(events.GuildAvailable, guild);
  await Promise.resolve();

  client.emit(events.MessageDelete, old);
  const fresh = welcome(guild, 'fresh');
  client.emit(events.MessageCreate, fresh);
  client.emit(events.MessageDelete, fresh);
  assert.deepEqual(handled.map(({ message }) => message.id), ['pending', 'fresh']);
});
