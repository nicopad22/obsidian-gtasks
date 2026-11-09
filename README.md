# Obsidian Google Tasks Sync (`obsidian-gtasks`)

An Obsidian desktop plugin that synchronizes Markdown tasks (`- [ ] ... #task`) to **Google Tasks** using the **Google Tasks REST API (v1)**.

---

## Features

- **Flexible, Order-Independent Tag Syntax:** Write `#task`, `#<category>`, and `#YYYY-MM-DD` anywhere in your task line—tags are parsed regardless of position and stripped from the final task title sent to Google Tasks.
- **Dynamic Task Lists (`#<category>`):** Maps your category tag directly to a Google Tasks list (`TaskList`), automatically fetching existing lists or creating new ones on the fly (defaults to `"HOY"` when omitted).
- **Idempotent Sync via Inline Hidden Comments:** Appends `%%gtask:<TASK_ID>%%` to synced lines so tasks are never duplicated across edits, cursor movements, or file renames.
- **Non-Intrusive Automatic Sync:** Debounced `editor-change` and `vault.on('modify')` listeners sync newly written `#task` lines and inject the `%%gtask:<TASK_ID>%%` footprint using targeted editor range replacements that preserve your cursor position and scroll state.
- **Manual Command Palette Trigger:** Run **"Google Tasks Sync: Sync tasks in current file"** on demand at any time.
- **Zero External Runtime Dependencies:** Uses a transient Node `http` loopback server (`127.0.0.1:42813/callback`) with PKCE (`S256`) for OAuth 2.0 authentication and Obsidian's native `requestUrl` for all network requests.

---

## Task Syntax & Format

To mark a Markdown checkbox for synchronization, it must:
1. Be an **unchecked** task (`- [ ] ...`).
2. Contain the anchor tag `#task`.
3. Not already have a `%%gtask:...%%` footprint.

### Supported Tags

| Tag | Required? | Description |
| :--- | :---: | :--- |
| `#task` | **Yes** | Anchor tag identifying the line for Google Tasks sync. Stripped from the final title. |
| `#<category>` | No | Target Google Tasks list title (any tag other than `#task` or `#YYYY-MM-DD`). Defaults to **`HOY`** if omitted. Stripped from the final title. |
| `#YYYY-MM-DD` | No | Due date in ISO format (e.g., `#2026-11-15`), converted to RFC 3339 (`2026-11-15T00:00:00.000Z`). Stripped from the final title. |

### Examples

All of the following formats are valid:

```markdown
- [ ] #task #HOY Clean garage #2026-11-15
- [ ] Buy groceries for dinner #2026-12-01 #personal #task
- [ ] #work Review pull requests #task
- [ ] #task Call dentist #2026-11-18
```

After synchronization, the plugin appends an Obsidian hidden comment containing the created Google Task ID:

```markdown
- [ ] #task #HOY Clean garage #2026-11-15 %%gtask:MDEyMzQ1Njc4OWFiY2RlZg%%
```

| Input Markdown Line | Google Task Title | Google `TaskList` | Due Date (RFC 3339) |
| :--- | :--- | :--- | :--- |
| `- [ ] #task #HOY Clean garage #2026-11-15` | `Clean garage` | `HOY` | `2026-11-15T00:00:00.000Z` |
| `- [ ] Buy groceries #2026-12-01 #personal #task` | `Buy groceries` | `personal` | `2026-12-01T00:00:00.000Z` |
| `- [ ] #work Review pull requests #task` | `Review pull requests` | `work` | *(none)* |
| `- [ ] #task Call dentist` | `Call dentist` | `HOY` *(default)* | *(none)* |

---

## Google Cloud OAuth 2.0 Setup

Because Google Tasks belongs to your personal Google account, you need a Google Cloud OAuth 2.0 Desktop Client to authorize the plugin once.

### 1. Enable the Google Tasks API
1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Navigate to **APIs & Services → Library**, search for **Google Tasks API**, and click **Enable**.

### 2. Configure the OAuth Consent Screen
1. Go to **APIs & Services → OAuth consent screen** (or **Google Auth Platform → Audience**).
2. Choose **External** user type and fill in the required app name and support email fields.
3. Add the scope `https://www.googleapis.com/auth/tasks` (or leave default scopes).
4. Under **Test users**, click **+ Add Users** and add your own **Gmail address**.
   > **Tip (Avoid 7-day token expiration):** Apps left in *Testing* status have their refresh tokens expired every 7 days by Google. If you click **Publish app** to move it to *In production* (you do **not** need to submit for Google verification for personal use), you can bypass the warning screen once via **Advanced → Go to `<App Name>` (unsafe)** and your refresh token will remain valid indefinitely.

### 3. Create OAuth 2.0 Desktop Credentials
1. Go to **APIs & Services → Credentials**.
2. Click **+ Create Credentials → OAuth client ID**.
3. Select **Desktop app** as the Application type.
4. Click **Create**, then copy your **Client ID** and **Client Secret** (or download the JSON file).

---

## Installation

### Option A: Symlink for Development
```bash
git clone <your-repo-url> obsidian-gtasks
cd obsidian-gtasks
npm install
npm run build

ln -s "$(pwd)" "/path/to/your/vault/.obsidian/plugins/obsidian-gtasks"
```

### Option B: Manual Copy
1. Build the project with `npm install && npm run build`.
2. Create the directory `<Vault>/.obsidian/plugins/obsidian-gtasks/`.
3. Copy `main.js` and `manifest.json` into `<Vault>/.obsidian/plugins/obsidian-gtasks/`.

### Enable & Authenticate in Obsidian
1. Open **Obsidian → Settings → Community plugins**.
2. Disable **Restricted mode**, reload plugins, and enable **Google Tasks Sync**.
3. Open **Settings → Google Tasks Sync**:
   - Enter your **Google OAuth Client ID** and **Google OAuth Client Secret**.
   - Click **Authenticate** and complete the consent flow in your browser (`http://127.0.0.1:42813/callback`).

---

## Plugin Settings

| Setting | Default | Description |
| :--- | :--- | :--- |
| **Google OAuth Client ID** | `""` | OAuth 2.0 Client ID from Google Cloud Console. |
| **Google OAuth Client Secret** | `""` | OAuth 2.0 Client Secret (`GOCSPX-...`) from Google Cloud Console. |
| **Default category (`TaskList`)** | `"HOY"` | Default Google Tasks list title when a `#task` line has no `#<category>` tag. |
| **Automatic background sync** | `true` | Automatically scans and syncs newly written `#task` lines after typing pauses. |
| **Auto-sync debounce delay (ms)** | `2000` | Delay in milliseconds after typing stops before automatic sync runs. |

---

## Architecture

```text
.
├── main.ts          # Plugin lifecycle, settings UI, command registration, and cursor-safe editor sync
├── parser.ts        # Order-independent #task / #<category> / #YYYY-MM-DD parser and %%gtask:<ID>%% formatter
├── auth.ts          # Loopback OAuth 2.0 server (127.0.0.1:42813/callback), PKCE, and token refresh
├── tasksApi.ts      # Google Tasks REST API (v1) client using Obsidian's native requestUrl
├── parser.test.ts   # Unit tests for task parsing, date validation, and idempotency
├── manifest.json    # Obsidian plugin metadata
└── esbuild.config.mjs
```

---

## Development & Testing

```bash
# Install dependencies
npm install

# Run unit tests
npm test

# Start esbuild in watch mode for development
npm run dev

# Type-check with tsc and bundle for production
npm run build
```
