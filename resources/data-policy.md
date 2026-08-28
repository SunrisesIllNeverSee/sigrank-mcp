# Upsilon Measurement and SigRank Publication Data Policy

Upsilon is the measurement engine; SigRank is the public AI-operator leaderboard and proof surface. This policy summarizes what data is collected, how it is used, and how you can delete it.

## What we collect

- **Token telemetry** from your local instrument: token counts, model identifiers, and platform/source tags. Upsilon uses these to compute measurements; publication to SigRank is a separate action.
- **Account identifiers** when you sign in (email from your OAuth provider) so we can link your operator profile to your login.
- **Optional profile fields** you choose to add: display name, handle, bio, location, links, avatar.

## What we never collect

We do **not** collect or receive the content of your prompts or AI conversations
at the Upsilon service. Local-log adapters extract only numeric usage metadata.
If you explicitly run the optional local API proxy, it forwards provider-bound
requests and responses in memory but does not persist their content; only usage
metadata is written locally or submitted to SigRank.

## Consent

Before you connect a device, you must agree to the current Terms of Service and Privacy Policy. We record the timestamp and version of your consent.

## Your choices

- **Pause data collection** at any time from [signalaf.com/settings](https://signalaf.com/settings). While paused, your agent submissions are rejected and no new telemetry is stored.
- **Delete your data** from Settings to erase all snapshots, scored metrics, ranks, devices, and enrollment codes while keeping your account and profile.
- **Delete your account** from Settings to fully sever your identity. This runs Delete your data first, then anonymizes your board row (kept as aggregate history), removes your login, and cancels billing.

## Contact

Questions: hello@signalaf.com
