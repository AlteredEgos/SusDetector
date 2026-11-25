# SusDetector

One SusDetector process watches Discord’s native welcome messages across the servers you configure. If a new member’s welcome disappears within the configured window, the bot checks for a moderator deletion. In `enforce` mode, it assigns that server’s `suspected bot` role, applies a 24-hour Discord timeout, and posts the outcome to that server’s moderators channel. The role stays assigned until a moderator removes it.

Discord’s delete event contains the message ID, channel ID, and guild ID. It supplies no actor. The bot records the welcome message on creation, gives the audit log three seconds to catch up, and checks for moderator deletions involving the same member and channel. Discord can group several deletions in one audit entry and those entries omit message IDs. A matching entry suppresses action. An unavailable or inconclusive audit log produces an alert with no automatic action. A successful lookup with no match can still miss a moderator deletion.

## Set up

1. Install Node.js 22.12 or newer. In the [Discord Developer Portal](https://discord.com/developers/applications), create or select the **SusDetector** application. On its **Bot** page, copy the token for your `.env` file. On **Installation**, enable **Guild Install** and add the `bot` scope. Use the same install link and bot token for all your servers.
2. In each server, give the bot **View Audit Log** for moderator deletion checks. For `enforce` mode, also grant **Manage Roles** and **Timeout Members**. Grant **View Channel** in the welcome and alert channels and **Send Messages** in the alert channel. Privileged intents can stay disabled.
3. In each server, set the **System Messages Channel** and enable Discord’s native welcome messages. Welcome posts from other bots are outside the rule.
4. For each server in `enforce` mode, create a `suspected bot` role with no added permissions and place it below the bot’s highest role. Enable Discord’s **Developer Mode** to copy the server, moderators channel, and role IDs.
5. From the extracted directory, create the config files and install dependencies.

   ```bash
   cp .env.example .env
   cp guilds.example.json guilds.json
   chmod 600 .env
   npm install --no-audit --no-fund
   ```

6. Put the bot token in `.env`. In `guilds.json`, replace the sample IDs, add one entry per server, and remove any unused examples. Start the bot and check for a `Watching native welcomes` line for each server.

   ```bash
   npm start
   ```

## Per-server configuration

Each object in the `guilds` array has these settings. Write Discord IDs as quoted strings.

| Setting | Value |
| --- | --- |
| `guildId` | Server ID |
| `alertChannelId` | Text or announcement channel ID in this server, visible to your moderators and the bot |
| `roleId` | Suspected bot role ID in this server, required in `enforce` mode |
| `deleteWindowSeconds` | Whole seconds from 1 to 120. Defaults to 10. |
| `mode` | `enforce` applies the role and timeout. `alert` posts alerts only. Defaults to `enforce`. |

Restart SusDetector after editing `guilds.json`. A server with missing permissions or invalid Discord setup is logged individually while the other servers continue running. If you repair a server’s setup, restart SusDetector to validate it again.

Set `SUSDETECTOR_CONFIG` in `.env` to use a different config file. Existing single-server `.env` settings still work when the default `guilds.json` is absent and `SUSDETECTOR_CONFIG` is unset. When the JSON file is present, its entries supply all per-server settings.

## Run at boot on Linux

The bot connects outbound to Discord. The host needs internet access. For a systemd host, place the configured project in a directory accessible to an unprivileged service account. After `npm start` works from that directory, you can run it as a service.

Save this example as `/etc/systemd/system/susdetector.service`. Use your service account, project directory, and absolute Node.js path from `command -v node`. Make sure the account can read `.env` and the guild configuration.

```ini
[Unit]
Description=SusDetector Discord bot
Wants=network-online.target
After=network-online.target

[Service]
User=susdetector
WorkingDirectory=/opt/susdetector
ExecStart=/usr/bin/node --env-file=.env bot.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now susdetector.service
sudo journalctl -u susdetector.service -f
```

Use `sudo systemctl restart susdetector.service` after changing the server list or settings.

## Verify in Discord

The bot observes messages while online and ignores bulk deletion events. Discord can refuse moderation actions because of role hierarchy or insufficient permissions. The alert reports the two outcomes independently. Alerts include the member, channel, and deleted message ID and do not ping the member.

If an alert says `Blocked`, read the reason after it. SusDetector’s highest role must be above the configured role and the member’s highest role. This applies even if SusDetector has Administrator. Discord exempts the server owner and members with Administrator from timeouts.

Run the read-only permission check from the configured project directory. Use the server ID and a current member’s user ID.

```bash
npm run diagnose -- <server-id> <member-id>
```

The command uses the configured bot token and reports current Discord roles, permissions, and action eligibility. It leaves all roles and timeouts alone and can run while the regular service is online. Eligibility means the local checks pass. Discord still makes the final decision on any action.

To test the actual changes on a current test account, add `--apply`. The server entry must use `enforce` mode. This runs the same moderation actions as a welcome deletion and records `SusDetector manual moderation test` as the audit reason. It applies the configured role and a real 24-hour timeout, so use an account intended for testing. The terminal reports the two action results separately. Clear the timeout and remove the test role from the member in Discord when finished.

```bash
npm run diagnose -- <server-id> <member-id> --apply
```

Automatic enforcement and the diagnostic both refresh the bot’s membership, the target’s membership, and guild roles from Discord before checking permissions.

| Test | Expected behavior |
| --- | --- |
| New member deletes their own native welcome within the window | A mod alert. In `enforce` mode, the member also receives the role and a 24-hour timeout. |
| Moderator deletes another member’s welcome within the window | When the matching audit entry is available, the bot skips the incident. |
| Someone deletes a normal post or deletes a welcome after the window | No action or alert. |
| Trigger the rule in two configured servers | Each alert appears in that server’s configured channel. Each server uses its configured mode and role. |

`npm test` exercises message matching, audit correlation, membership validation, action handling, and server isolation without connecting to Discord.

## License and policies

The source code is available under the [MIT License](LICENSE). See the [Terms of Service](TERMS_OF_SERVICE.md) and [Privacy Policy](PRIVACY_POLICY.md) for the SusDetector instance run by AlteredEgos.

[Discord Gateway events](https://docs.discord.com/developers/events/gateway-events#message-delete) · [Message types](https://docs.discord.com/developers/resources/message#message-object-message-types) · [Audit logs](https://docs.discord.com/developers/resources/audit-log) · [Member timeout](https://docs.discord.com/developers/resources/guild#modify-guild-member)
