'use strict';

const { createTracker } = require('./guard');

function watchGuilds(client, { Events, MessageType }, configs, { validateSetup, handleDeletion, logger = console }) {
  const sessions = new Map();
  let stopped = false;

  async function startGuild(guild) {
    const config = configs.get(guild.id);
    if (stopped || !config || !guild.available || sessions.has(guild.id)) return;

    const session = { active: false, tracker: createTracker(config.windowMs), config };
    sessions.set(guild.id, session);
    try {
      await validateSetup(guild, config);
      if (sessions.get(guild.id) !== session) return;
      session.active = true;
      logger.info(`[${guild.id}] Watching native welcomes in ${guild.name}. Mode: ${config.mode}.`);
    } catch (error) {
      if (sessions.get(guild.id) !== session) return;
      sessions.delete(guild.id);
      logger.error(`[${guild.id}] Monitoring disabled for ${guild.name}. ${error.message}`);
    }
  }

  function stopGuild(guild) {
    sessions.delete(guild.id);
  }

  client.once(Events.ClientReady, () => {
    for (const id of configs.keys()) {
      const guild = client.guilds.cache.get(id);
      if (guild?.available) {
        void startGuild(guild);
      } else {
        logger.warn(`[${id}] Server unavailable. Monitoring will start when the bot can access it.`);
      }
    }
  });

  client.on(Events.GuildCreate, startGuild);
  client.on(Events.GuildAvailable, startGuild);
  client.on(Events.GuildUnavailable, stopGuild);
  client.on(Events.GuildDelete, stopGuild);

  client.on(Events.MessageCreate, (message) => {
    const session = sessions.get(message.guildId);
    if (!session?.active || message.type !== MessageType.UserJoin ||
        message.channelId !== message.guild?.systemChannelId || !message.author || message.author.bot) return;
    session.tracker.remember({
      id: message.id,
      memberId: message.author.id,
      channelId: message.channelId,
      createdAt: message.createdTimestamp,
    });
  });

  client.on(Events.MessageDelete, (message) => {
    const { guild } = message;
    const session = sessions.get(message.guildId);
    if (!session?.active || guild?.id !== message.guildId) return;
    const welcome = session.tracker.take(message.id, message.channelId);
    if (!welcome) return;

    const isActive = () => sessions.get(guild.id) === session;
    handleDeletion(guild, welcome, session.config, isActive).catch((error) => {
      logger.error(`[${guild.id}] Could not finish handling ${welcome.id}. ${error.message}`);
    });
  });

  const cleanup = setInterval(() => {
    for (const session of sessions.values()) session.tracker.prune();
  }, 10000).unref();

  return () => {
    stopped = true;
    clearInterval(cleanup);
    sessions.clear();
  };
}

module.exports = { watchGuilds };
