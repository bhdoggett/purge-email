# Purge Email App

A desktop app (built with Tauri 2 and React) that helps you clean out old Gmail messages. The app uses Google's OAuth to access your Gmail account and the Jev AI model to judge whether messages are worth keeping.

Like the CLI, the app doesn't delete anything at first. Instead, it adds Gmail labels to messages it thinks should go, one sub-label per kind of mail (for example `purge/newsletter` and `purge/promotion`), plus `purge/maybe` for mail Jev wasn't sure about. You can review them in Gmail before applying the delete.

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

Choose which kinds of messages Jev should label for purging (newsletters, promotions, social, security alerts, shipping, scams, work, automated) and which to always keep (personal correspondence, receipts, account records, etc.). Two more checkboxes under "Always keep" protect emails with attachments and starred emails; both are on by default. Choose a strictness level (Careful, Balanced, or Aggressive), set the age threshold (default: 10 years), and pick the label name. Labels look like `purge/newsletter`, with `purge/maybe` for mail Jev wasn't sure about. In development builds only, you can set a scan limit (the "Limit (dev)" field).

### Scan

The app searches Gmail for emails older than your configured age (skipping spam, trash, chats, and, when those checkboxes are on, emails with attachments and starred emails). For each email, it sends the following to the Jev AI model to judge whether it's worth keeping:
- Sender (from), recipients (to, cc)
- Subject, date, and snippet
- Whether you've replied in the thread
- Whether there's an unsubscribe header
- Gmail labels applied to the email

Email bodies and attachments are never sent to Jev. The scan runs in the background and can be paused or resumed.

### Review

After a scan, Review shows one row per label that has email in it, with the count. Each row has **Open in Gmail** and **Move N to Trash**. The `maybe` row carries a note to look through it before deleting. **Move all to Trash** covers every kind label but never `maybe`. Confirmation says whether starred emails are skipped (when they're protected) or included. Each email moves on its own, so replies in the same conversation thread stay intact, and Trash empties itself after 30 days.

If you change the age, the attachment checkbox, or the starred checkbox after a scan, the labels may include mail that is now protected. Review then shows **Rescan needed** and disables every Move to Trash button until you rescan. Other changes (kinds, protections, strictness, label name) show **Update labels to match new rules**, which moves, adds and removes labels without a rescan. After a label-name change, the old labels are left empty and you can delete them in Gmail.

To delete in Gmail yourself, click "Open in Gmail" on a row, star or unlabel anything you want to keep, then turn off Conversation view (Settings, gear, See all settings, General tab) so deleting a thread doesn't take newer replies with it. Then select all and delete.

**Empty spam folder** moves everything in spam to Trash, one email at a time.

### Settings

Access settings from a button in the header. Here you can remove your saved Jev key, Google credentials, and scan data to start fresh or switch accounts.

## Architecture

- **Frontend:** React + TypeScript, with CSS modules for styling
- **Backend:** Rust (via Tauri), routes API requests through a proxy that adds authentication keys
- **Data Storage:** macOS Keychain for credentials, IndexedDB for scan results and settings

API requests to Gmail and Jev are built by the frontend but routed through a Rust proxy (`app/src-tauri/src/proxy.rs`) that adds the authentication keys. This ensures your credentials and API keys never reach the web view.
