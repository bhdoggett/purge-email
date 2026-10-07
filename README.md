# purge-email

Clean out old Gmail mail. Gmail search does the cheap filtering; TypeSafe's Jev model judges whether each remaining message is worth keeping. Nothing is deleted at first: `plan` only adds a Gmail label called `purge` to the messages it wants to delete. You review that label in Gmail, and only `apply --yes` moves them to Trash, and even then messages only go to Trash (recoverable for 30 days).

## What gets protected

- Anything with an attachment (excluded by the Gmail query and re-checked in code)
- Starred messages
- Messages Jev judges likely (≥ 0.5) to be:
  - personal correspondence with family or friends
  - receipts and financial records
  - account, legal, medical, or government records

Messages where every keep-probability is below 0.1 get the `purge` label. Everything in between is marked `review` and left alone.

## Setup

1. `npm install`
2. Put your TypeSafe key in `.env` as `JEV_API_KEY=...` (or `TYPESAFE_API_KEY`).
3. Create Gmail OAuth credentials:
   1. Go to https://console.cloud.google.com/ and create a project.
   2. Enable the **Gmail API** (APIs & Services → Library).
   3. Configure the **OAuth consent screen**: type External, then add your own Gmail address under **Test users**.
   4. Go to Credentials → Create credentials → **OAuth client ID** → Application type **Desktop app**.
   5. Put the client ID and secret in `.env` as `GOOGLE_CLIENT_ID=...` and `GOOGLE_CLIENT_SECRET=...`.
4. `npm run auth` opens a browser. Approve access, and the refresh token gets saved to `token.json`.

`.env`, `token.json`, and `reports/` are gitignored.

## Use

```sh
# Try a small sample first
npm run plan -- --limit 200

# Full run (default: older than 10 years)
npm run plan -- --years 10
```

`plan` writes a report to `reports/plan-*.csv` and adds the `purge` label in Gmail.

Review in Gmail by searching `label:purge`. To save a message, remove its `purge` label or star it.

```sh
npm run apply           # shows how many labeled messages would go
npm run apply -- --yes  # moves label:purge (minus starred) to Trash

# Spam folder
npm run spam            # shows count only
npm run spam -- --yes   # moves to Trash
```

Options for `plan`: `--keep-at 0.5`, `--trash-below 0.1`, `--concurrency 4`.

Long runs are safe to stop and restart:

- Email details and Jev answers are cached in `reports/summaries.jsonl` and `reports/judgments.jsonl`, so a restart skips Gmail and Jev for emails already done, and changing thresholds doesn't re-bill.
- Gmail rate limits are retried until they clear; an email that fails for another reason is marked `review` instead of stopping the run.
- The `purge` label is added in batches of 500 as the run goes. `reports/labeled.jsonl` records what was labeled, so a rerun never re-adds the label to something you removed it from.
