# purge-email

Clean out old Gmail mail. Gmail search does the cheap filtering; TypeSafe's Jev model judges whether each remaining message is worth keeping. Nothing is deleted until you review a plan and run `apply --yes`, and even then messages only go to Trash (recoverable for 30 days).

## What gets protected

- Anything with an attachment (excluded by the Gmail query and re-checked in code)
- Starred messages
- Messages Jev judges likely (≥ 0.5) to be:
  - personal correspondence with family or friends
  - receipts and financial records
  - account, legal, medical, or government records

Messages where every keep-probability is below 0.1 are planned for Trash. Everything in between is marked `review` and left alone.

## Setup

1. `npm install`
2. Put your TypeSafe key in `.env` as `JEV_API_KEY=...` (or `TYPESAFE_API_KEY`).
3. Create Gmail OAuth credentials:
   1. Go to https://console.cloud.google.com/ and create a project.
   2. Enable the **Gmail API** (APIs & Services → Library).
   3. Configure the **OAuth consent screen**: type External, then add your own Gmail address under **Test users**.
   4. Go to Credentials → Create credentials → **OAuth client ID** → Application type **Desktop app**.
   5. Download the JSON and save it as `credentials.json` in this folder.
4. `npm run auth` opens a browser. Approve access, and `token.json` gets saved.

`.env`, `credentials.json`, `token.json`, and `reports/` are gitignored.

## Use

```sh
# Dry run on a small sample first
npm run plan -- --limit 200

# Full plan (default: older than 10 years)
npm run plan -- --years 10

# Review reports/plan-*.csv, then:
npm run apply -- reports/plan-XXXX.json        # shows count only
npm run apply -- reports/plan-XXXX.json --yes  # moves to Trash

# Spam folder
npm run spam          # shows count only
npm run spam -- --yes # moves to Trash
```

Options for `plan`: `--keep-at 0.5`, `--trash-below 0.1`, `--concurrency 8`.

Jev judgments are cached in `reports/judgments.jsonl`, so re-running `plan` with different thresholds doesn't re-bill already-judged messages.
