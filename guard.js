'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;
const AUDIT_LOOKBACK_MS = 5 * 60 * 1000;
const AUDIT_LIMIT = 100;
const DISCORD_EPOCH = 1420070400000n;
const CLOCK_TOLERANCE_MS = 2000;
const REASON = 'Native welcome message deleted immediately after join; possible self-deletion';

function createTracker(windowMs, now = Date.now) {
  const welcomes = new Map();

  function prune(at = now()) {
    for (const [id, welcome] of welcomes) {
      if (at - welcome.seenAt <= windowMs) break;
      welcomes.delete(id);
    }
  }

  return {
    remember(welcome) {
      const seenAt = now();
      prune(seenAt);
      if (!welcomes.has(welcome.id)) welcomes.set(welcome.id, { ...welcome, seenAt });
    },
    take(id, channelId) {
      const deletedAt = now();
      prune(deletedAt);
      const welcome = welcomes.get(id);
      if (!welcome || welcome.channelId !== channelId) return null;
      welcomes.delete(id);
      const ageMs = deletedAt - welcome.createdAt;
      if (ageMs < -CLOCK_TOLERANCE_MS || ageMs > windowMs + CLOCK_TOLERANCE_MS) return null;
      return { ...welcome, elapsedMs: Math.max(0, deletedAt - welcome.seenAt) };
    },
    prune,
  };
}

function auditResult(entries, welcome) {
  const since = welcome.createdAt - AUDIT_LOOKBACK_MS;
  let oldest = Infinity;
  let ambiguous = false;
  for (const entry of entries) {
    // A moderator can delete several messages into a single, older audit entry.
    const createdAt = Number((BigInt(entry.id) >> 22n) + DISCORD_EPOCH);
    oldest = Math.min(oldest, createdAt);
    if (createdAt < since) continue;

    const channelId = entry.options?.channel_id;
    if (channelId && channelId !== welcome.channelId) continue;
    if (entry.target_id && entry.target_id !== welcome.memberId) continue;
    if (channelId && entry.target_id && entry.user_id) {
      if (entry.user_id !== welcome.memberId) return 'moderator';
    } else {
      ambiguous = true;
    }
  }
  if (ambiguous || (entries.length === AUDIT_LIMIT && oldest >= since)) return 'inconclusive';
  return 'no-match';
}

function isWelcomeForMembership(welcome, member) {
  if (!member || member.user.bot || !member.joinedTimestamp) return false;
  const afterJoinMs = welcome.createdAt - member.joinedTimestamp;
  return afterJoinMs >= -2000 && afterJoinMs <= 30000;
}

async function fetchModerationState(guild, memberId, roleId) {
  const [roles, bot, member] = await Promise.all([
    guild.roles.fetch(),
    guild.members.fetchMe({ force: true }),
    guild.members.fetch({ user: memberId, force: true }),
  ]);
  return { bot, member, role: roleId ? roles.get(roleId) : null };
}

function roleLabel(role) {
  return `“${role.name.replace(/\s+/g, ' ')}” (${role.id})`;
}

function memberBlocker(member, bot) {
  if (member.id === member.guild.ownerId) return 'member owns the server';
  if (!bot) return 'SusDetector’s server membership is unavailable';
  const botRole = bot.roles.highest;
  const memberRole = member.roles.highest;
  if (botRole.comparePositionTo(memberRole) <= 0) {
    return `member’s highest role ${roleLabel(memberRole)} is at or above SusDetector’s ${roleLabel(botRole)}`;
  }
  return null;
}

function timeoutBlocker(member, bot) {
  if (member.id !== member.guild.ownerId && member.permissions.has('Administrator')) {
    return 'member has Administrator';
  }
  return memberBlocker(member, bot) ?? (bot.permissions.has('ModerateMembers')
    ? 'Discord.js marked the member ineligible for a timeout'
    : 'SusDetector lacks Timeout Members');
}

function roleBlocker(member, bot, role) {
  const access = memberBlocker(member, bot);
  if (access) return access;
  if (!bot.permissions.has('ManageRoles')) return 'SusDetector lacks Manage Roles';
  if (!role) return 'configured suspected bot role is missing';
  if (role.id === member.guild.id || role.managed) return `role ${roleLabel(role)} cannot be assigned manually`;
  if (bot.roles.highest.comparePositionTo(role) <= 0) {
    return `configured role ${roleLabel(role)} is at or above SusDetector’s ${roleLabel(bot.roles.highest)}`;
  }
  return 'Discord.js marked the configured role uneditable';
}

function checkTimeout(member, now = Date.now()) {
  const bot = member.guild.members.me;
  if (member.communicationDisabledUntilTimestamp >= now + DAY_MS) return 'Existing timeout kept';
  if (bot && member.moderatable) return null;
  return `Blocked — ${timeoutBlocker(member, bot)}`;
}

function checkRole(member, role) {
  const bot = member.guild.members.me;
  if (role && member.roles.cache.has(role.id)) return 'Already assigned';
  if (bot && member.manageable && role?.editable && !role.managed) return null;
  return `Blocked — ${roleBlocker(member, bot, role)}`;
}

async function applyActions(member, role, now = Date.now(), reason = REASON) {
  const errors = [];
  const until = now + DAY_MS;

  let timeout = checkTimeout(member, now);
  if (timeout === null) {
    try {
      await member.disableCommunicationUntil(until, reason);
      timeout = `Applied until <t:${Math.floor(until / 1000)}:F>`;
    } catch (error) {
      errors.push(error);
      timeout = 'Failed';
    }
  }

  let roleStatus = checkRole(member, role);
  if (roleStatus === null) {
    try {
      await member.roles.add(role.id, reason);
      roleStatus = 'Assigned';
    } catch (error) {
      errors.push(error);
      roleStatus = 'Failed';
    }
  }
  return { timeout, role: roleStatus, errors };
}

module.exports = {
  AUDIT_LIMIT, applyActions, auditResult, checkRole, checkTimeout, createTracker,
  fetchModerationState, isWelcomeForMembership, roleLabel,
};
