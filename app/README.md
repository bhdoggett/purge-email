# Purge Email App

A desktop app (built with Tauri 2 and React) that helps you clean out old Gmail messages. The app uses Google's OAuth to access your Gmail account and the Jev AI model to judge whether messages are worth keeping.

Like the CLI, the app doesn't delete anything at first. Instead, it adds a Gmail label (named `purge` by default) to messages it thinks should go. You can review them in Gmail before applying the delete.

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

- **Development mode** (when running `npm run tauri dev`): uses the `VITE_PURGE_LABEL` variable from `app/.env.development`, which defaults to `purge-test`
- **Release builds**: falls back to `purge` when the variable is not set

This keeps development scans separate from production.

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

Configure which kinds of messages Jev should consider for deletion (newsletters, promotions, social media, etc.) and which kinds to always keep (personal correspondence, receipts, account records, etc.). Choose a strictness level (Careful, Balanced, or Aggressive) and set the age threshold (default: 10 years, meaning older emails are candidates for deletion). In development builds only, you can set a scan limit to test with fewer emails (appears as "Limit (dev)" field).

### Scan

The app searches Gmail for emails older than your configured age (excluding attachments and starred messages). For each email, it sends the following to the Jev AI model to judge whether it's worth keeping:
- Sender (from), recipients (to, cc)
- Subject, date, and snippet
- Whether you've replied in the thread
- Whether there's an unsubscribe header
- Gmail labels applied to the email

Email bodies and attachments are never sent to Jev. The scan runs in the background and can be paused or resumed.

### Review

After a scan completes, you'll see a summary of emails Jev labeled for purging, plus how many it marked to keep and how many it wasn't sure about.

You have three options to complete the deletion:

**Option 1: Use the in-app "Move N to Trash" button**
This moves each labeled email on its own, so replies in the same conversation thread stay intact. Trash empties itself after 30 days.

**Option 2: Delete in Gmail directly**
Click "Open in Gmail" to see the labeled emails in Gmail. You can star or remove the label from any you want to keep. To delete the rest, go to Gmail Settings (gear) → See all settings → General tab, turn off Conversation view, then search for `label:purge` (or `label:purge-test` in development builds), select all, and delete. (Turning off Conversation view prevents deleting newer replies in the same thread.)

**Option 3: Empty the spam folder**
Use the in-app "Empty spam folder" button to move all emails in your spam folder to Trash in one action. This also moves each email individually to preserve conversation threads. Trash empties itself after 30 days.

### Settings

Access settings from a button in the header. Here you can remove your saved Jev key, Google credentials, and scan data to start fresh or switch accounts.

## Architecture

- **Frontend:** React + TypeScript, with CSS modules for styling
- **Backend:** Rust (via Tauri), routes API requests through a proxy that adds authentication keys
- **Data Storage:** macOS Keychain for credentials, IndexedDB for scan results and settings

API requests to Gmail and Jev are built by the frontend but routed through a Rust proxy (`app/src-tauri/src/proxy.rs`) that adds the authentication keys. This ensures your credentials and API keys never reach the web view.
