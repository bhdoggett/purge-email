# Purge Email App

A desktop app (built with Tauri 2 and React) that helps you clean out old Gmail messages. The app uses Google's OAuth to access your Gmail account and the Jev AI model to judge whether messages are worth keeping.

The app never deletes, trashes or moves email. It only adds Gmail labels to messages it thinks should go, one sub-label per kind of mail (for example `purge/newsletter` and `purge/promotion`), plus `purge/maybe` for mail Jev wasn't sure about. You review each label in Gmail and do any deleting there yourself. As a backstop, the app's Rust proxy refuses any Gmail request that would trash, spam or delete mail.

## Setup and Development

### Prerequisites

- Node.js and npm (development builds)
- macOS (Tauri app currently targets macOS)
- A TypeSafe/Jev API key (for judging messages)
- A Google account and a web browser (for Gmail and Google Cloud setup)

The setup wizard will walk you through creating a Google Cloud project and enabling the Gmail API.

### Installation

1. From the `app/` directory, install dependencies:
   ```bash
   npm install
   ```

2. Run the development server:
   ```bash
   npm run tauri dev
   ```

   This opens the app in a window. During development, it uses the `purge-test` label to avoid interfering with production labels.

### Setup Wizard

When you first run the app, a 6-step setup wizard walks you through the process:

1. **Add your Jev key**: Create an API key on the TypeSafe dashboard and paste it into the app. The app tests it with a tiny request (under a cent).
2. **Create a Google Cloud project**: Go to Google Cloud and create a new project (any name works, like "Purge Email").
3. **Turn on the Gmail API**: Enable the Gmail API for your project. It takes a minute or two to take effect.
4. **Add yourself as a test user**: Go to Google Auth Platform, make sure your project is in Testing mode, and add your Gmail address as a test user.
5. **Create a Desktop OAuth client**: Create OAuth credentials (type: Desktop app) in Google Cloud and paste the client ID and secret into the app.
6. **Sign in with Google**: The app opens a browser and asks you to approve access to your Gmail account. Your OAuth credentials are saved to the macOS Keychain.

**Important:** Your Google Cloud project must stay in Testing mode. In Testing mode, Google sign-in expires every 7 days, so the app will periodically ask you to sign in again. The macOS Keychain (under service `dev.purge-email`) securely stores your Jev API key, Google client ID and secret, Gmail refresh token, and Gmail email address. No `.env` file is needed.

### Development vs. Release Labels

- **Development mode** (when running `npm run tauri dev`): the label name starts as the `VITE_PURGE_LABEL` variable from `app/.env.development`, which defaults to `purge-test`
- **Release builds**: the label name starts as `purge` when the variable is not set

This keeps development scans separate from production. You can change the label name on the Rules screen (1 to 40 letters, numbers, spaces, `-` or `_`; no `/`).

## Testing

Run the full test suite before committing:

```bash
# Unit and integration tests
npm test

# TypeScript type checking
npm run typecheck

# Rust backend tests
(cd src-tauri && cargo test)
```

## Building for macOS

To create a release build:

```bash
npm run tauri build
```

This produces an unsigned `.app` bundle. macOS will ask you to allow it in System Settings → Privacy & Security the first time you run it.

## How It Works

The app has six main screens:

### Welcome

Shown on first run if you haven't started the setup wizard yet. Explains what the app does and offers a button to begin setup.

### Setup Wizard (first run only)

See "Setup Wizard" above for the 6-step process that configures your Jev key, Google Cloud project, and Gmail OAuth access.

### Rules

Choose which kinds of messages Jev should label for purging (newsletters, promotions, social, security alerts, shipping, scams, work, automated) and which to always keep (personal correspondence, receipts, account records, etc.). Two more checkboxes under "Always keep" protect emails with attachments and starred emails; both are on by default. Choose a strictness level (Careful, Balanced, or Aggressive), set the age threshold (default: 10 years; 0 means any age), and pick the label name. Labels look like `purge/newsletter`, with `purge/maybe` for mail Jev wasn't sure about. If labels under the chosen name already hold mail the app didn't label (probably your own labels), Rules warns: "Labels under '<name>' already exist in your Gmail. Pick a different name so the app doesn't mix with your own labels." The app never removes or moves a label it has no record of adding. In development builds only, you can set a scan limit (the "Limit (dev)" field).

### Scan

The app searches Gmail for emails older than your configured age (skipping spam, trash, chats, and, when those checkboxes are on, emails with attachments and starred emails). For each email, it sends the following to the Jev AI model to judge whether it's worth keeping:
- Sender (from), recipients (to, cc)
- Subject, date, and snippet
- Whether you've replied in the thread
- Whether there's an unsubscribe header
- Gmail labels applied to the email

Email bodies and attachments are never sent to Jev. The scan runs in the background and can be paused or resumed.

### Review

After a scan, Review shows one row per label that has email in it, with the count (starred emails are left out of the count when they're protected) and an **Open in Gmail** button. The `maybe` row carries a note to look through it before deleting. Review has no delete or trash buttons: the app only labels.

**Before deleting anything in Gmail, make sure Review shows no warning.** Review shows a prominent note above the rows whenever the labels in Gmail may not match your current rules:

- **"Your labels don't match your current rules yet. Click Update labels before deleting anything in Gmail."** You changed the kinds, protections, strictness or label name since the labels were made. **Update labels** moves, adds and removes labels without a rescan. After a label-name change, the old labels are left empty and you can delete them in Gmail.
- **"…Click Rescan before deleting anything in Gmail."** You changed the age, the attachment checkbox or the starred checkbox. Only a new scan finds the right emails.
- **"…Scan first before deleting anything in Gmail."** The app doesn't know which rules made the labels, for example after Settings → Clear scan data or before a scan has finished. Update labels isn't offered here, because without a scan it would remove every label.
- **"Some labels are still settling in Gmail. Try Update labels again in a few minutes."** Gmail's label lists can lag for a few minutes after the app changes a label. For mail labeled in the last 10 minutes, the app changes nothing unless Gmail confirms the label it recorded, so it never undoes a change you just made. Click Update labels again once the lists catch up.

#### Deleting in Gmail safely

1. In Gmail, open Settings (gear) → See all settings. On the General tab, set Conversation view to off and save. Otherwise deleting a thread also deletes newer replies in it.
2. Click **Open in Gmail** on a row in Review.
3. To keep an email, **remove the label from it**. Starring is not enough: Gmail's select-all deletes everything under the label, starred mail included.
4. Select all and delete. Gmail keeps deleted mail in Trash for 30 days.

### Settings

Access settings from a button in the header. Here you can remove your saved Jev key, Google credentials, and scan data to start fresh or switch accounts. After clearing scan data, Review asks you to scan again before deleting anything in Gmail.

## Architecture

- **Frontend:** React + TypeScript, with CSS modules for styling
- **Backend:** Rust (via Tauri), routes API requests through a proxy that adds authentication keys
- **Data Storage:** macOS Keychain for credentials, IndexedDB for scan results and settings

API requests to Gmail and Jev are built by the frontend but routed through a Rust proxy (`app/src-tauri/src/proxy.rs`) that adds the authentication keys. This ensures your credentials and API keys never reach the web view.
