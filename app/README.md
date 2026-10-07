# Purge Email App

A desktop app (built with Tauri 2 and React) that helps you clean out old Gmail messages. The app uses Google's OAuth to access your Gmail account and the Jev AI model to judge whether messages are worth keeping.

Like the CLI, the app doesn't delete anything at first. Instead, it adds a Gmail label (named `purge` by default) to messages it thinks should go. You can review them in Gmail before applying the delete.

## Setup and Development

### Prerequisites

- Node.js and npm (development builds)
- macOS (Tauri app currently targets macOS)
- A Google Cloud project with Gmail API enabled and OAuth credentials

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

### Credentials

The app stores your Gmail OAuth credentials securely in the macOS Keychain under the service name `dev.purge-email`. When you first run the app, a setup wizard will ask you to sign in with your Google account and configure your settings. No `.env` file is needed for the app — all configuration happens through the in-app setup wizard.

**Note:** Your Google Cloud project must be in Testing mode, with your email address added as a test user. In Testing mode, Google sign-in expires every 7 days, so the app will periodically ask you to sign in again.

### Development vs. Release Labels

- **Development mode** (when running `npm run tauri dev`): uses the `purge-test` label (configured in `.env.development`)
- **Release builds** (signed apps distributed to users): uses the `purge` label

This keeps development scans separate from production.

## Testing

Run the full test suite before committing:

```bash
# Unit and integration tests
npm test

# TypeScript type checking
npm run typecheck

# Rust backend tests
cd src-tauri && cargo test
```

## Building for macOS

To create a signed or unsigned release build:

```bash
npm run tauri build
```

This produces an unsigned `.app` bundle. macOS will ask you to allow it in System Settings → Privacy & Security the first time you run it.

## What the App Does

The app walks through a setup wizard where you:

1. Sign in with your Google account (OAuth)
2. Configure how aggressive the deletion rules should be (Careful, Balanced, or Aggressive)
3. Set a scan limit (how many recent messages to scan)
4. Review the results and see which messages would be labeled

After you start a scan, the app:

- Searches Gmail for old messages (older than your configured age, excluding attachments and starred messages)
- Sends each message to the Jev AI model to judge its importance
- Applies the `purge` label to messages it thinks are safe to delete
- Shows you a summary so you can review before anything is moved to Trash

You can then go to Gmail, search for `label:purge`, review the labeled messages, and star or remove the label from anything you want to keep. When you're ready, use the CLI (`npm run apply --yes`) to move them to Trash.

## Architecture

- **Frontend:** React + TypeScript, with CSS modules for styling
- **Backend:** Rust (via Tauri), handles Gmail API requests and Jev model calls
- **Data Storage:** macOS Keychain for credentials, local SQLite for scan results

All API calls to Gmail and Jev are made from the Rust backend, so your credentials and API keys never touch the web view.
