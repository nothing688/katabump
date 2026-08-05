# Katabump Server Auto-Renewal Tool

[English Version](README_EN.md) | [中文说明](README.md)

An automation script for renewing Katabump servers. It uses Playwright + CDP (Chrome DevTools Protocol) + a Cloudflare Turnstile extension to simulate real user interactions, reliably bypasses Cloudflare Turnstile CAPTCHAs, and automatically solves ALTCHA PoW challenges for fully unattended server renewal.

Supports both **Windows local scheduled execution** (recommended) and **GitHub Actions cloud execution**.

---

## ✨ Features

- **Real browser, hidden window**: Chrome renders fully (satisfying Cloudflare detection), but the window is positioned off-screen via `--window-position=-32000,-32000` — completely invisible to the user.
- **Smart CAPTCHA bypass**: `MouseEvent.screenX/screenY` patching + Shadow DOM Hook forces Turnstile into auto-pass mode.
- **ALTCHA auto-solve**: Automatically solves the ALTCHA proof-of-work challenge before renewal, completes in ~3 seconds.
- **Login persistence**: Chrome `--user-data-dir` automatically saves cookies, no re-login needed for 14 days.
- **4-day frequency check**: Avoids wasteful daily runs. Windows Task Scheduler triggers daily, the script internally decides whether to actually run.
- **WeChat notifications**: WxPusher pushes rich-text messages (with screenshots) directly to WeChat, no VPN needed.
- **GitHub as image host**: Screenshots auto-upload to GitHub (raw.githubusercontent.com is fast in China), local copies deleted after successful upload.
- **Missed-run auto-recovery**: Windows Task Scheduler `-StartWhenAvailable` recovers missed runs after boot.

---

## 🚀 Windows Local Execution (Recommended)

The most stable approach: Local Chrome + Windows Task Scheduler, runs daily at 12:00, results pushed to WeChat.

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v18+
- [Google Chrome](https://www.google.com/chrome/) installed
- [GitHub CLI](https://cli.github.com/) logged in (used for image hosting)

### 2. Install Dependencies

```bash
cd katabump-fork
npm install
```

### 3. Configure Account

Copy `users.json.example` to `users.json` and fill in your credentials:

```json
[
  {"username": "your_email@example.com", "password": "your_password"}
]
```

> `users.json` is in `.gitignore`, won't be uploaded to GitHub.

**Alternative — Environment variable** (GitHub Actions Secret compatible):
- `USERS_JSON`: JSON string (takes priority over `users.json`)

### 4. Configure Chrome Path (first run only)

```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

Defaults: Linux → `/usr/bin/google-chrome`, Windows → `%TEMP%\katabump_chrome_data`.

### 5. (Optional) Configure WxPusher Notifications

**5.1 Register WxPusher**

1. Visit https://wxpusher.zjiecode.com to sign up
2. Create an app → copy the `appToken`
3. Scan the QR code with WeChat to follow the **wxpusher** public account
4. Visit https://wxpusher.zjiecode.com/zone to find your `UID`

**5.2 Create config file**

Copy `wxpusher.example.json` to `wxpusher.json` and fill in:

```json
{
  "appToken": "AT_your_real_token",
  "uids": ["UID_your_real_uid"],
  "githubRepo": "yourname/yourrepo",
  "githubBranch": "main"
}
```

> `wxpusher.json` is in `.gitignore`.

**5.3 GitHub Image Host Setup**

Screenshots auto-upload to your configured GitHub repo. Make sure:

- `gh auth status` shows logged in
- Token has `repo` scope

Default upload path: `screenshots/YYYY-MM-DD/`.

### 6. First Run (Manual Login + Auto-save Cookies)

```powershell
$env:FORCE_RUN = "true"  # Skip the 4-day check
node action_renew.js
```

Expected output:
- Chrome launches (window off-screen)
- Browser login → cookies auto-saved to `USER_DATA_DIR`
- ALTCHA auto-solved → renewal successful
- Screenshot uploaded to GitHub → WxPusher pushes to WeChat
- Local screenshot auto-deleted

### 7. Configure Windows Task Scheduler

Open PowerShell **as Administrator** and run:

```powershell
$action  = New-ScheduledTaskAction -Execute 'node.exe' -Argument 'c:\path\to\katabump-fork\action_renew.js' -WorkingDirectory 'c:\path\to\katabump-fork'
$trigger = New-ScheduledTaskTrigger -Daily -At '12:00:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Katabump Renew' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force
```

**Key**: `StartWhenAvailable` recovers missed runs after boot.

### 8. Verify Task

```powershell
Get-ScheduledTask -TaskName 'Katabump Renew' | Format-List TaskName,State,@{N='Trigger';E={$_.Triggers[0].ToString()}},@{N='StartWhenAvailable';E={$_.Settings.StartWhenAvailable}}
```

Should show:

```
TaskName           : Katabump Renew
State              : Ready
StartWhenAvailable : True
```

---

## ☁️ GitHub Actions Cloud Execution (Alternative)

> **⚠️ Caution**: GitHub Actions datacenter IPs are easily flagged by Cloudflare. Requires residential proxy or CAPTCHA-solving service. Local execution is more reliable.

### 1. Fork the Repository

Fork this repository to your GitHub account.

### 2. Configure Secrets

Go to **Settings → Secrets and variables → Actions**, add:

| Secret | Format |
|--------|--------|
| `USERS_JSON` | `[{"username":"...","password":"..."}]` |
| `HTTP_PROXY` (optional) | `http://user:pass@ip:port` |
| `WXPUSHER_APP_TOKEN` (optional) | `AT_xxx` |
| `WXPUSHER_UIDS` (optional) | `UID_xxx` (comma-separated for multiple) |
| `GITHUB_TOKEN` | Auto-provided |

### 3. Enable Workflow

Go to **Actions** and enable `renew.yml`. It runs daily at **UTC 08:00 (Beijing 16:00)**.

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `USERS_JSON` | - | JSON string of users (highest priority) |
| `USERS_CONFIG` | `users.json` | User config file path |
| `WXPUSHER_CONFIG` | `wxpusher.json` | WxPusher config file path |
| `CHROME_PATH` | `/usr/bin/google-chrome` (Linux) / auto (Windows) | Chrome executable path |
| `CHROME_USER_DATA_DIR` | `%TEMP%/katabump_chrome_data` | Chrome user data dir (cookie persistence) |
| `LAST_RUN_FILE` | `.last_run` | Frequency check timestamp file |
| `FORCE_RUN` | - | `true` to skip 4-day check |
| `SHOW_WINDOW` | - | `true` to show Chrome window (debug only) |
| `HTTP_PROXY` | - | HTTP proxy |
| `LOGIN_STATE_FILE` | `login_state.json` | Login state file (legacy, deprecated) |

---

## 🛠️ Project Structure

```
katabump-fork/
├── action_renew.js              # Main script (WxPusher + GitHub image host + 4-day check)
├── renew.js                     # Original Windows local script (legacy, kept for compat)
├── users.json                   # (Create) Account credentials
├── users.json.example           # Template
├── wxpusher.json                # (Create) WxPusher config
├── wxpusher.example.json        # Template
├── .last_run                    # Frequency check timestamp (auto-maintained)
├── turnstilePatch/              # Turnstile extension (patches MouseEvent.screenX/Y)
│   ├── manifest.json
│   └── script.js
└── .github/workflows/
    └── renew.yml                # GitHub Actions config
```

---

## ❓ FAQ

### Renewal failed: "Turnstile CAPTCHA failed 3 times"

Cloudflare flagged the current IP/environment. Solutions:

1. **Local**: Usually doesn't happen (home IP has good reputation). If it does, close all Chrome instances and retry.
2. **GitHub Actions**: Requires residential proxy (`HTTP_PROXY` Secret) or CAPTCHA solver like CapSolver.

### No WeChat notifications received

1. Check `wxpusher.json` has correct `appToken` and `uids`
2. Confirm you've scanned the QR code to follow the **wxpusher** public account
3. Confirm your UID appears in zone page (https://wxpusher.zjiecode.com/zone)
4. Script log shows `[WxPusher] HTTP xxx response: {...}` — check error code

### Script skipped, didn't run

The 4-day check kicked in — less than 4 days since last successful run.

```powershell
$env:FORCE_RUN = "true"; node action_renew.js  # Force run
```

### Chrome failed to start

Check `CHROME_PATH` env var or modify the default value in the script.

---

## 📜 License

MIT
