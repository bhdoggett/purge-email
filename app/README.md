# Purge Email App

A desktop app (built with Tauri 2 and React) that helps you clean out old Gmail messages. The app uses Google's OAuth to access your Gmail account and the Jev AI model to judge whether messages are worth keeping.

The app never deletes, trashes or moves email. It only adds Gmail labels to messages it thinks should go, one sub-label per kind of mail (for example `purge/newsletter` and `purge/promotion`), plus `purge/maybe` for mail Jev wasn't sure about and, if you turn it on, `purge/personal` for trivial personal mail. You review each label in Gmail and do any deleting there yourself. As a backstop, the app's Rust proxy refuses any Gmail request that would trash, spam or delete mail.

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

The app has seven main screens. After setup, the work runs in four stages: Rules › Scan › Review › Apply.

### Welcome

Shown on first run if you haven't started the setup wizard yet. Explains what the app does and offers a button to begin setup.

### Setup Wizard (first run only)

See "Setup Wizard" above for the 6-step process that configures your Jev key, Google Cloud project, and Gmail OAuth access.

### Rules

Choose which kinds of messages Jev should label for purging (newsletters, promotions, social, security alerts, shipping, scams, work, automated) and which to always keep (personal correspondence, receipts, account records, etc.). Two more checkboxes under "Always keep" protect emails with attachments and starred emails; both are on by default. Choose a strictness level (Careful, Balanced, or Aggressive), set the age: "Older than" a number of months or years (default: 10 years; 0 means any age), and pick the label name. Labels look like `purge/newsletter`, with `purge/maybe` for mail Jev wasn't sure about. If labels under the chosen name already hold mail the app didn't label (probably your own labels), Rules warns: "Labels under '<name>' already exist in your Gmail. Pick a different name so the app doesn't mix with your own labels." The app never removes or moves a label it has no record of adding. In development builds only, you can set a scan limit (the "Limit (dev)" field).

#### Trivial personal mail and close people

"Trivial personal mail" is a separate checkbox at the end of the purge list, off by default. When it is on, personal mail is labeled `purge/personal` if Jev finds it trivial (logistics, quick replies, forwards) and the sender isn't one of your close people. For mail you sent yourself (from your address, or carrying Gmail's Sent label), the recipients count instead: it is kept if any To or Cc recipient is close. If the sender's address (or, for your own mail, every recipient) can't be read, the email is kept as "sender unknown". Personal mail from a close person, and personal mail Jev finds meaningful, is always kept. Mail Jev scores as a receipt or an account, legal or medical record (when those are checked under "Always keep") is kept first, as before. With the checkbox off, personal mail is handled exactly as before.

Close people come from your Sent mail. While the checkbox is on, a Close people panel on the Rules screen offers **Count my sent mail**. Counting reads only the To, Cc and Date headers of the messages in your Sent folder, from Gmail; nothing is sent to Jev. Someone is close automatically once you have sent them at least 25 emails in at least 3 different years; change both numbers in the panel ("Auto-tick people I've emailed at least … times over … or more different years") and the automatic ticks update right away. The panel lists everyone you've written to, most emailed first, with "214 emails over 12 years" and a **Close** checkbox; automatic ticks are marked "auto". Ticking or unticking a box is your choice and always wins over the automatic rule. Search the list with "Search people"; it shows 100 at a time. **Recount** reads only sent mail that wasn't counted before. Counting keeps going if you leave the screen, saves its progress every 200 emails, and doesn't run while a scan or Apply runs (they wait for it too). If counting stops before the end, the panel shows what it counted so far with **Continue counting**; until the count is complete, personal mail is kept and Jev isn't asked about it. Counts made while signed in to a different Gmail account are ignored, as if nothing were counted. Your own address and no-reply addresses are left out.

Ticking someone as close takes effect straight away in Review and Apply, with no rescan. Unticking someone works differently: Jev was never asked about mail from close people, so their personal mail stays kept as "not checked yet" until the next scan asks Jev about it. Turning on trivial personal mail needs a scan so Jev can check personal emails, but emails Jev already judged aren't judged again; only the extra question is asked.

### Scan

The app searches Gmail for emails older than your configured age (skipping spam, trash, chats, and, when those checkboxes are on, emails with attachments and starred emails). For each email, it sends the following to the Jev AI model to judge whether it's worth keeping:
- Sender (from), recipients (to, cc)
- Subject, date, and snippet (Gmail's ~200-character preview of the text), unless "Send email previews to Jev" is off under Privacy on the Rules screen
- Attachment file names, when emails with attachments aren't protected
- Whether you've replied in the thread
- Whether there's an unsubscribe header
- Gmail labels applied to the email

With "Trivial personal mail" on, the scan asks Jev one more question, "Is this email personally meaningful to keep?", only for emails Jev scored as personal (at or above the strictness level's protect line) from someone who isn't close, and only once per email. Emails kept for being starred, having attachments, being too new, or being a receipt or record, and emails whose sender can't be read, are never asked. It sends the same details as above (the preview only when previews are on) and its cost is added to the scan's cost; Rules notes that the cost may be a little higher. If the question fails for an email, the email is kept (and counted as kept) and the next scan asks again. An email is labeled trivial only when the chance it is meaningful is below 20% (Careful), 30% (Balanced) or 40% (Aggressive). Until your sent mail is fully counted for the signed-in account, the question isn't asked and personal mail is kept, since the app can't yet tell who is close.

Full email bodies and attachment contents are never sent to Jev. With previews off, the preview is also not kept on this computer; emails Jev already judged keep their results. The scan runs in the background and can be paused or resumed.

### Review

Scan only judges your mail and saves the results on this computer. It doesn't touch Gmail, so no labels appear there during a scan. Review shows every scanned email in a table with its sender, subject, date, label and Jev's reason.

- **Filter** by decision (Purge, Maybe, Keep, or Changed by you), by category, by attachments (with or without), by text in the sender, subject or attachment file names, or by age ("Older than" a number of months or years; empty means any age). The age filter leaves out emails whose date can't be read. Rows with attachments show a paperclip; hover the subject to see the file names. Emails with attachments only appear when "Emails with attachments" is unchecked under Always keep on the Rules screen, since protected ones aren't scanned.
- **Select** rows with a click, Cmd-click to add or remove one, Shift-click for a range, or Cmd-A for every row the filters show.
- **Change** the selected emails with **Use suggested label**, **Move to** a label, **Maybe**, **Keep (no label)**, or **Undo my change**.

Your changes are saved on this computer, cost nothing, and don't run Jev again. They survive rescans and Settings → Clear scan data. Nothing reaches Gmail until you apply.

While an age is set, mail newer than it is kept ("Kept: newer than …"), and so is mail whose date can't be read ("Kept: date unknown").

With trivial personal mail on, personal emails show "Kept: close person", "Kept: sender unknown", "Kept: personal, not checked yet" (Jev hasn't been asked yet, or your sent mail isn't fully counted, so it is kept), "Kept: meaningful 72%", or, when labeled, "personal, trivial 85%". "Trivial personal mail" is in the category filter and in **Move to**. Missing information keeps the email: before your sent mail is fully counted, while the extra question has no answer, or when the sender can't be read, personal mail is kept. Review picks up a finished count without reopening.

Raising the age or turning on the attachment or starred checkbox after a scan needs no rescan: the scanned emails that no longer fit are kept, and Apply removes the labels the app gave them, unless you chose a label for them in Review. Lowering the age (or setting it to 0) or turning off the attachment or starred checkbox could include emails the scan never looked at, so Review and Apply ask you to rescan first.

### Apply

Apply checks Gmail and shows what will change, for example "Add 120 labels · Move 4 · Remove 2", with a count for each label. Changes to your rules since the last apply show up here as pending changes too. Click **Apply labels** to write them. If you renamed the label, the old labels are emptied and you can delete them in Gmail.

A choice you make in Review wins over a change you made to that email in Gmail before then. A change you make in Gmail after Apply has labeled the email wins over your earlier Review choice.

Gmail's label lists can lag for a few minutes after the app changes a label. For mail labeled in the last 10 minutes, the app changes nothing unless Gmail confirms the label it recorded, so it never undoes a change you just made. If Apply says "Some labels are still settling in Gmail. Try Apply again in a few minutes.", wait and try again.

After applying, Apply lists each label with its count and an **Open in Gmail** button. The `maybe` label carries a note to look through it before deleting. Apply has no delete or trash buttons: the app only labels.

#### Deleting in Gmail safely

1. In Gmail, open Settings (gear) → See all settings. On the General tab, set Conversation view to off and save. Otherwise deleting a thread also deletes newer replies in it.
2. Click **Open in Gmail** on a label in Apply.
3. To keep an email, **remove the label from it**. Starring is not enough: Gmail's select-all deletes everything under the label, starred mail included.
4. Select all and delete. Gmail keeps deleted mail in Trash for 30 days.

### Settings

Access settings from a button in the header. Here you can remove your saved Jev key, Google credentials, and scan data to start fresh or switch accounts. Removing keys keeps scan data and the key that encrypts it, so you don't pay Jev again after re-entering your keys. Your Review changes are kept. After clearing scan data, Apply asks you to scan again before it writes anything to Gmail.

## Architecture

- **Frontend:** React + TypeScript, with CSS modules for styling
- **Backend:** Rust (via Tauri), routes API requests through a proxy that adds authentication keys
- **Data Storage:** macOS Keychain for credentials, IndexedDB for scan results and settings

API requests to Gmail and Jev are built by the frontend but routed through a Rust proxy (`app/src-tauri/src/proxy.rs`) that adds the authentication keys. This ensures your Gmail credentials and Jev key never reach the web view.

Email details saved by a scan (sender, recipients, subject, date, snippet, attachment names) and Jev's scores are encrypted on disk with AES-256-GCM (`app/src/storage/crypto.ts`). The key is generated the first time a version with encryption opens, and kept in the Keychain (Credential Manager on Windows) alongside your other secrets; the web view receives only this key. On that first open, emails and scores saved by an earlier version are encrypted in place. Your sent-mail counts (the addresses and names you've written to, how often, in which years, and which sent messages were counted) and your Close ticks are encrypted the same way. Message IDs of scanned mail, the labels the app added, your Review choices, and settings are stored unencrypted. Clear scan data keeps the sent-mail counts and Close ticks. This protects the saved email details if someone copies the app's data folder, reads a backup, or uses another account on the computer. It does not protect against malware running as you or someone using the app while you are signed in to your computer, since both can get the key the same way the app does. Remove keys in Settings leaves this key in place. If the key is lost (for example after a Keychain reset, or a data folder restored without it), the app can't read the saved scan data, so it clears it and you scan again; the sent-mail counts and Close ticks are cleared too, and you count again. Data saved before this version may remain in older backups and in unused space in the database file. Clearing scan data doesn't guarantee it is erased.
