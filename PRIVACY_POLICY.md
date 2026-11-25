# SusDetector Privacy Policy

Effective November 24, 2026

This policy covers the SusDetector instance operated by AlteredEgos. Other operators are responsible for the privacy practices of the copies they host.

## What SusDetector uses and why

- **Welcome and deletion events.** SusDetector receives Discord server message events in channels it can access. To recognize a native welcome message and tell how quickly it was deleted, it checks the message type, server and channel IDs, message ID, member ID, and timestamps. The bot requests Discord’s standard server and server-message intents.
- **Server membership, roles, and audit logs.** SusDetector checks join times, permissions, and roles to confirm the member who joined and determine what actions it can take. It checks recent Discord message-deletion audit-log entries, including the relevant actor, member, and channel IDs, to look for moderator deletions.
- **Moderation results and diagnostics.** SusDetector records whether it flagged an incident and whether it assigned a role or applied a timeout. When the operator runs a diagnostic for a specific member, the terminal displays account and server names, IDs, role names, permissions, and the action results. Discord is the source of this information.

SusDetector uses this information to detect welcome-message deletions, carry out configured moderation actions, and troubleshoot the bot.

## Who can see the information

SusDetector uses Discord to receive events, check permissions, send alerts, and apply moderation actions. Alerts appear in the server’s configured moderation channel. Anyone with access to that channel can see the affected account, message and channel identifiers, and action outcomes in the alert. Discord may record role and timeout actions in the server’s audit log. The operator can see the bot’s operational logs and diagnostic output. Discord handles information on its platform under its own [Privacy Policy](https://discord.com/privacy).

## How long information is kept

SusDetector keeps recent welcome-message tracking in memory for the short detection window. Operational logs on the host and alerts on Discord can retain incident identifiers and outcomes after that window. Host and server settings affect how long those records are available. The operator keeps records under their control only as long as needed for moderation, troubleshooting, or legal requirements. Discord controls its own platform records.

## Data requests and questions

For questions or to request access to, correction of, or deletion of data SusDetector holds about you, ask a moderator on the server where you encountered SusDetector to forward your request to AlteredEgos, the bot operator. Include the server name and your Discord user ID so the operator can find the relevant records. The operator may verify that the account is yours before handling your request and will handle requests for records under their control, subject to applicable law. For information held directly by Discord, see [Discord’s Privacy Policy](https://discord.com/privacy).
