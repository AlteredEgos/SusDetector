'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { AUDIT_LIMIT, applyActions, auditResult, createTracker, fetchModerationState, isWelcomeForMembership } = require('./guard');

const createdAt = 1_795_540_000_000;
const welcome = { id: 'welcome', memberId: 'member', channelId: 'welcome-channel', createdAt };

function auditEntry(at, actor = 'moderator', channelId = welcome.channelId, targetId = welcome.memberId) {
  const id = ((BigInt(at) - 1420070400000n) << 22n).toString();
  return { id, target_id: targetId, user_id: actor, options: { channel_id: channelId } };
}

test('matches the exact welcome message and consumes a deletion only once', () => {
  let clock = createdAt;
  const tracker = createTracker(10_000, () => clock);
  tracker.remember(welcome);
  clock += 10_000;
  assert.equal(tracker.take('other', welcome.channelId), null);
  assert.equal(tracker.take(welcome.id, 'other'), null);
  assert.equal(tracker.take(welcome.id, welcome.channelId).elapsedMs, 10_000);
  assert.equal(tracker.take(welcome.id, welcome.channelId), null);
});

test('rejects late deletes and stale gateway replays', () => {
  let clock = createdAt;
  const tracker = createTracker(10_000, () => clock);
  tracker.remember(welcome);
  clock += 10_001;
  assert.equal(tracker.take(welcome.id, welcome.channelId), null);
  clock += 60_000;
  tracker.remember(welcome);
  assert.equal(tracker.take(welcome.id, welcome.channelId), null);
});

test('moderator attribution matches the author and channel within the lookback', () => {
  const entries = [
    auditEntry(createdAt + 1000, 'moderator', 'different-channel'),
    auditEntry(createdAt + 500, 'moderator', welcome.channelId, 'different-member'),
    auditEntry(createdAt, welcome.memberId),
    auditEntry(createdAt - 301_000),
  ];
  assert.equal(auditResult(entries, welcome), 'no-match');
  entries.push(auditEntry(createdAt - 120_000));
  assert.equal(auditResult(entries, welcome), 'moderator');
});

test('incomplete audit evidence cannot authorize automatic moderation', () => {
  const entry = auditEntry(createdAt);
  delete entry.options;
  assert.equal(auditResult([entry], welcome), 'inconclusive');
  const crowded = Array.from({ length: AUDIT_LIMIT }, (_, i) => auditEntry(createdAt + i, 'mod', 'other'));
  assert.equal(auditResult(crowded, welcome), 'inconclusive');
});

test('requires the original recent membership and a non-bot user', () => {
  const member = { user: { bot: false }, joinedTimestamp: createdAt - 500 };
  assert.equal(isWelcomeForMembership(welcome, member), true);
  assert.equal(isWelcomeForMembership(welcome, { ...member, joinedTimestamp: createdAt + 5000 }), false);
  assert.equal(isWelcomeForMembership(welcome, { ...member, user: { bot: true } }), false);
  assert.equal(isWelcomeForMembership(welcome, undefined), false);
});

test('applies a 24-hour timeout and the configured role independently', async () => {
  const calls = [];
  const role = { id: 'suspected-bot', editable: true };
  const member = {
    guild: { members: { me: {} } },
    moderatable: true,
    manageable: true,
    async disableCommunicationUntil(until) { calls.push(['timeout', until]); },
    roles: { cache: new Map(), async add(id) { calls.push(['role', id]); } },
  };
  const result = await applyActions(member, role, createdAt);
  assert.deepEqual(calls, [['timeout', createdAt + 86_400_000], ['role', role.id]]);
  assert.equal(result.role, 'Assigned');
  assert.match(result.timeout, /^Applied/);

  const failure = new Error('Missing Permissions');
  member.disableCommunicationUntil = async () => { throw failure; };
  assert.deepEqual(await applyActions(member, role, createdAt), {
    role: 'Assigned', timeout: 'Failed', errors: [failure],
  });
});

test('leaves a longer timeout and an existing role in place', async () => {
  const role = { id: 'suspected-bot' };
  const member = {
    guild: { members: { me: {} } },
    communicationDisabledUntilTimestamp: createdAt + 2 * 86_400_000,
    roles: { cache: new Map([[role.id, role]]) },
  };
  assert.deepEqual(await applyActions(member, role, createdAt), {
    role: 'Already assigned', timeout: 'Existing timeout kept', errors: [],
  });
});

function testRole(id, name, position, editable = true) {
  return { id, name, position, editable, comparePositionTo(other) { return position - other.position; } };
}

function testMember(highest, permissions = [], botPermissions = ['ManageRoles', 'ModerateMembers']) {
  const bot = { roles: { highest: testRole('bot-role', 'SusDetector', 5) }, permissions: new Set(botPermissions) };
  return {
    id: 'member',
    guild: { id: 'server', ownerId: 'owner', members: { me: bot } },
    permissions: new Set(permissions),
    roles: { highest, cache: new Map(), async add() {} },
  };
}

test('explains the shared role hierarchy blocker for both actions', async () => {
  const member = testMember(testRole('member-role', 'Moderator', 5));
  const role = testRole('suspected', 'suspected bot', 2);
  const result = await applyActions(member, role, createdAt);
  assert.match(result.role, /member’s highest role “Moderator” \(member-role\) is at or above SusDetector’s “SusDetector” \(bot-role\)/);
  assert.equal(result.timeout, result.role);
});

test('distinguishes a target with Administrator from a missing or higher configured role', async () => {
  const member = testMember(testRole('member-role', 'Members', 3), ['Administrator']);
  member.manageable = true;
  const result = await applyActions(member, null, createdAt);
  assert.equal(result.timeout, 'Blocked — member has Administrator');
  assert.equal(result.role, 'Blocked — configured suspected bot role is missing');

  const role = testRole('suspected', 'suspected bot', 6, false);
  assert.match((await applyActions(member, role, createdAt)).role, /configured role “suspected bot” .* is at or above SusDetector’s/);
});

test('identifies missing bot permissions or an unavailable bot membership', async () => {
  const member = testMember(testRole('member-role', 'Members', 3), [], []);
  const role = testRole('suspected', 'suspected bot', 2, false);
  assert.deepEqual(await applyActions(member, role, createdAt), {
    role: 'Blocked — SusDetector lacks Manage Roles', timeout: 'Blocked — SusDetector lacks Timeout Members', errors: [],
  });
  member.guild.members.me = null;
  const result = await applyActions(member, role, createdAt);
  assert.equal(result.role, 'Blocked — SusDetector’s server membership is unavailable');
  assert.equal(result.timeout, result.role);
});

test('moderation reads fresh members and uses the returned roles over cached data', async () => {
  const member = { id: 'member' };
  const bot = { id: 'bot' };
  const role = { id: 'suspected', editable: true };
  const guild = {
    roles: {
      cache: new Map([[role.id, { ...role, editable: false }], ['deleted', {}]]),
      async fetch() { return new Map([[role.id, role]]); },
    },
    members: {
      async fetchMe(options) { assert.deepEqual(options, { force: true }); return bot; },
      async fetch(options) { assert.deepEqual(options, { user: member.id, force: true }); return member; },
    },
  };
  assert.deepEqual(await fetchModerationState(guild, member.id, role.id), { bot, member, role });
  assert.equal((await fetchModerationState(guild, member.id, 'deleted')).role, undefined);
});
