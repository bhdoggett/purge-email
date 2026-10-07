# Purge Email desktop app — design

Date: 2026-10-06
Status: draft for review

The app is a new artifact; the CLI keeps working throughout.

## Goal

A Tauri desktop app that lets someone who doesn't code clean out old Gmail mail with Jev. The app walks them through setup, lets them pick which kinds of email to purge with checkboxes, scans their mailbox, and puts a `purge` label on what Jev picks. The person reviews and deletes in Gmail, or uses one button in the app to move labeled mail to Trash.

This is a portfolio project for personal use and for people the author hands it to directly. It is not meant for public distribution.

## Decisions already made

- **Each user brings their own Google Cloud project.** The wizard walks them through creating it. No Google app verification. Sign-ins expire after 7 days while the project is in Testing mode.
- **TypeScript logic, thin Rust layer.** React runs the scan, the Jev questions, the rules, and labeling. Rust holds the credentials, runs Google sign-in, and makes network calls. Secrets never reach the webview.
- **Credentials are stored in the OS keychain** (macOS Keychain; Windows Credential Manager via the same crate), not in an app-encrypted file.
- **Review happens in Gmail.** The app has no in-app email list. It labels, reports counts, and links to Gmail.
- **Stack:** Tauri 2, Vite, React, TypeScript, CSS modules with design tokens in a `:root` block. No Tailwind, no inline styles.

## Project layout

```
purge-email/
  core/          shared TypeScript: Jev questions, rules, decide()
  src/           existing CLI, updated to import core/
  app/
    src/         React + Vite + CSS modules: screens, Gmail client, scan loop
    src-tauri/   Rust: keychain, Google sign-in, network proxy
  docs/
```

## Rust layer

Four Tauri commands. Nothing else in Rust.

| Command | Does | Returns |
| --- | --- | --- |
| `save_secret(kind, value)` | Stores the Jev key or the Google client ID/secret in the keychain. `kind` is `"jev"` or `"google_client"`. | nothing |
| `secrets_status()` | Reports which credentials exist and whether Gmail is signed in. | `{ jev: bool, googleClient: bool, gmailEmail: string \| null }` |
| `google_sign_in()` | Runs the OAuth loopback flow with PKCE: opens the system browser, listens on a random `127.0.0.1` port, exchanges the code, stores the refresh token in the keychain, and reads the address with Gmail `users.getProfile`. | the signed-in email address |
| `api_request({ url, method, headers, body })` | Sends an HTTPS request to an allowlisted host and attaches credentials. | `{ status, headers, body }` |

Also: `clear_secrets()` for the Settings screen.

### Network proxy rules

- Only `https://gmail.googleapis.com/` and `https://api.typesafe.ai/` are allowed. Anything else is refused before any network I/O.
- Gmail requests get `Authorization: Bearer <access token>`. Rust exchanges the refresh token for an access token, caches it in memory, and refreshes it a minute before it expires.
- TypeSafe requests get `Authorization: Bearer <Jev key>`, the header SDK 0.6.0 sends. The webview's SDK is built with a placeholder key; Rust overwrites the header.
- If the refresh token is rejected (`invalid_grant`), the command returns a typed `SignInExpired` error.

Scope: `https://www.googleapis.com/auth/gmail.modify` only.

Crates: `keyring`, `reqwest`, `tokio`, `serde`, `sha2`/`base64`/`rand` for PKCE, `tauri-plugin-opener`, `tauri-plugin-notification`.

## TypeScript layer

### Clients

- **Jev:** the existing `@typesafe-ai/sdk`, constructed with a custom `fetch` that routes through `api_request`. The typed SDK keeps working and never sees the real key.
- **Gmail:** a small hand-written REST client (`googleapis` doesn't run in a browser) over the same proxy: `listIds`, `getSummary`, `ensureLabel`, `addLabel`, `removeLabel`, `trash`, `getProfile`. It keeps the CLI's retry rules: retry rate limits until they clear, retry transient errors 5 times, fail otherwise.

### Jev questions (in `core/`)

Each email is judged once with four questions in one request:

1. **`kind` — Choice.** "What kind of email is this?" Options:
   - `newsletter` — newsletters, mailing lists, church or club bulletins, digests
   - `promotion` — marketing, sales, deals, coupons
   - `social` — social network notifications
   - `securityAlert` — password changes, new sign-ins, verification codes
   - `shipping` — shipping and delivery updates
   - `scam` — scams and phishing
   - `work` — work email from coworkers or about work projects
   - `automated` — other automated notifications
   - `none` — none of these, such as personal mail between people
2. **`personal` — Noul.** Personal correspondence with family or friends (same wording as the CLI).
3. **`financial` — Noul.** Receipt or financial record.
4. **`accountLegal` — Noul.** Account, legal, medical, or government record.

The state is the same as the CLI's: from, to, cc, subject, date, snippet, whether the owner replied in the thread, whether there is a `List-Unsubscribe` header, and Gmail labels.

Every stored answer carries a `questionsVersion`. If the question wording changes, old answers count as unjudged.

Expected cost is about the same as the CLI's four questions, about $2 for 55K emails. Implementation measures the real token count before a full scan.

### Rules and `decide()` (in `core/`)

Settings the user controls:

- **Purge kinds:** checkboxes for the 8 kinds. All checked by default.
- **Protect:** checkboxes for personal, financial, account/legal. All checked by default. Attachments and starred are always protected and shown as locked.
- **Age:** years, default 10.
- **Strictness:** Careful, Balanced (default), or Aggressive.

| Strictness | purge at | protect at |
| --- | --- | --- |
| Careful | 0.9 | 0.3 |
| Balanced | 0.8 | 0.5 |
| Aggressive | 0.6 | 0.7 |

`decide(message, answers, settings)`:

1. Starred or has an attachment → **keep**.
2. Not judged yet → **review**.
3. `protectScore` = highest probability among checked protect questions. If `protectScore ≥ protect at` → **keep**.
4. `purgeScore` = sum of `kind` probabilities over checked kinds. If `purgeScore ≥ purge at` → **purge**.
5. If `purgeScore ≥ 0.5` → **review**.
6. Otherwise → **keep**.

It returns the decision and a short reason, such as `promotion 0.97` or `personal 0.98`. Changing settings reruns `decide()` locally with no Jev calls.

The CLI switches to these questions and this `decide()` as well. Its old 4-question answers are ignored through `questionsVersion`.

### Local storage (IndexedDB)

| Store | Key | Holds |
| --- | --- | --- |
| `summaries` | message id | from, to, cc, subject, date, snippet, labels, thread id, attachment names, List-Unsubscribe flag |
| `answers` | message id | `questionsVersion`, kind probabilities, protect probabilities, input tokens |
| `labels` | message id | `labeledByApp: true`, `userRemoved: bool` |
| `settings` | `"settings"` | the rules above |
| `scan` | `"current"` | query, candidate ids, finished flag, started time |

### Scan loop

1. List candidate ids: `older_than:{age}y -has:attachment -is:starred -in:spam -in:trash -in:chats`.
2. List threads where the owner sent mail older than the cutoff (the "replied" signal).
3. For each candidate, with concurrency 4: load or fetch its summary, load or get the Jev answers, run `decide()`, and queue the id for labeling if the decision is purge and the id isn't already in `labels`.
4. Flush label adds in batches of 500 with `batchModify`.
5. Persist after every email, so closing the app loses nothing. The next launch offers **Resume scan**.

Pause stops new work and lets in-flight requests finish.

### Update labels (after a settings change)

1. List the ids that currently have `purge` in Gmail.
2. For every id in `labels` that is `labeledByApp` and no longer has the label in Gmail, set `userRemoved: true`. These are never labeled again.
3. Recompute decisions for all scanned emails.
4. Add `purge` to purge-decision ids that don't have it and aren't `userRemoved`.
5. Remove `purge` from labeled ids whose decision is no longer purge.

### Trash and spam

- **Move labeled emails to Trash:** lists `label:purge -is:starred` and trashes message by message, so thread siblings are never touched. Confirmation shows the count. Progress uses the same UI as the scan.
- **Empty spam folder:** lists `in:spam` and moves it to Trash, after confirmation.

## Screens

1. **Welcome.** What the app does, and three promises: it only labels and never deletes unless you choose to; keys stay in the Keychain; a typical mailbox costs about $2 in Jev usage.
2. **Setup wizard.** Six steps, shown as "Step N of 6", each checked off once verified:
   1. Jev key: link to the TypeSafe dashboard, paste field, **Test key** (one tiny Jev call).
   2. Create a Google Cloud project: link.
   3. Enable the Gmail API: link.
   4. Consent screen and test user: instructions that show the user's address.
   5. Create a Desktop OAuth client: paste the client ID and secret.
   6. Sign in with Google: shows the signed-in address.

   Errors route back to a step: `access_denied` → step 4, `SERVICE_DISABLED` / `accessNotConfigured` → step 3, `redirect_uri_mismatch` or `invalid_client` → step 5, Jev 401 → step 1.
3. **Rules.** The checkboxes, age, and strictness, plus an estimate before scanning: email count from a fast list call, Jev cost from measured tokens per email, and time from the observed Gmail pace (or a conservative default before the first scan).
4. **Scan.** Progress (below).
5. **Review and finish.** Counts; **Open in Gmail** (`https://mail.google.com/mail/u/0/#label/purge`); a conversation-view note with steps to turn it off before deleting in Gmail; **Move labeled emails to Trash**; **Empty spam folder**; **Update labels** when settings changed since the scan.
6. **Settings.** Replace or clear credentials, sign out of Gmail, and clear local scan data.

## Progress

- **Stage:** Finding old emails… → Reading and judging N of M → Labeling.
- **Progress bar** with time left from the pace over the last 200 emails, not the overall average.
- **Counts:** labeled purge, kept, review, failed.
- **Live feed** of the last 8 decisions, each with sender, subject, decision, and reason, for example "Groupon — 70% off spa days → purge (promotion 0.97)".
- **Rate-limit notice** in plain words: "Gmail asked us to slow down. Continuing in 12s."
- **Running Jev cost** from reported input tokens × $0.042 per million.
- **Header indicator** on every screen while a scan or trash job runs.
- **macOS notification** when a scan or trash job finishes.

## Errors

- Gmail rate limits: retried until they clear, and shown as the rate-limit notice.
- Jev rate limits and server errors: handled by the SDK's retry.
- One email failing to fetch or judge: marked review, counted as failed, and the scan continues.
- `SignInExpired`: the scan pauses and shows **Sign in again**, then resumes.
- Missing or bad credentials: route to the right wizard step with the error in plain words.

## Testing

- **Vitest:**
  - `decide()`: kind sums, protect cutoffs, the three strictness presets, attachment and starred always winning, unjudged → review.
  - Update labels: never re-adds a `userRemoved` label, and removes labels whose decision changed.
  - Error-to-wizard-step mapping.
  - Gmail client retry and backoff against a fake `fetch`.
  - The scan loop against fake Gmail and Jev clients, including resume after a stop.
- **Rust:** the proxy refuses hosts outside the allowlist and non-HTTPS URLs.
- **Manual end-to-end** on the author's account: complete the wizard, scan 200 emails, compare with the CLI's result, and open the label in Gmail.

## Visual design

Decided during implementation with the frontend-design skill: a color and type token system in `:root`, light and dark themes, visible keyboard focus, reduced motion respected.

## Out of scope

- Public distribution and Google app verification
- Multiple Gmail accounts
- An in-app email list or per-email overrides (review happens in Gmail)
- Windows and Linux testing (the code avoids macOS-only APIs except notifications)
- Code signing and notarization
