# Katabump Server Auto-Renewal Tool

[English Version](README_EN.md) | [中文说明](README.md)

这是一个用于自动续期 Katabump 服务器的自动化脚本。它利用 Playwright + CDP（Chrome DevTools Protocol）+ Cloudflare Turnstile 扩展来模拟真实用户操作，能够稳定绕过 Cloudflare Turnstile 验证码，并通过 ALTCHA PoW 自动验证，实现服务器续期的无人值守。

支持 **Windows 本地定时运行**（推荐）和 **GitHub Actions 云端运行**。

---

## ✨ 特性

- **真实浏览器，真头假隐**：窗口真实渲染满足 Cloudflare 检测，但通过 `--window-position=-32000,-32000` 隐藏在屏幕外，用户完全无感。
- **智能过盾**：使用 `MouseEvent.screenX/screenY` 修补 + Shadow DOM Hook，让 Turnstile 走 auto 模式自动通过。
- **ALTCHA 自动解**：续期前的 ALTCHA 工作量证明自动解出 token，3 秒完成。
- **登录态持久化**：通过 Chrome `--user-data-dir` 自动保存 cookies，14 天免登录。
- **4 天频率检查**：避免每天空跑浪费资源，Windows 计划任务每天触发，脚本内部自动判断。
- **微信通知**：通过 WxPusher 推送图文消息（含截图），国内直达，无需翻墙。
- **GitHub 作图床**：截图自动上传到 GitHub 仓库（raw.githubusercontent.com 国内访问快），上传成功即删除本地副本。
- **错过自动补跑**：Windows 计划任务 `-StartWhenAvailable`，电脑关机后开机自动补跑。

---

## 🚀 Windows 本地运行（推荐方案）

最稳定的方式：本地 Chrome + Windows 计划任务，每天 12:00 自动续期，微信收到结果通知。

### 1. 环境准备

- [Node.js](https://nodejs.org/) v18+
- [Google Chrome](https://www.google.com/chrome/) 已安装
- [GitHub CLI](https://cli.github.com/) 已登录（用于 GitHub 图床）

### 2. 安装依赖

```bash
cd katabump-fork
npm install
```

### 3. 配置账号

复制 `users.json.example` 为 `users.json`，填入你的账号：

```json
[
  {"username": "your_email@example.com", "password": "your_password"}
]
```

> `users.json` 已被加入 `.gitignore`，不会被上传到 GitHub。

**也可使用环境变量**（GitHub Actions Secret 兼容）：
- `USERS_JSON`: JSON 字符串（优先级高于 `users.json`）

### 4. 配置 Chrome 路径（仅首次）

设置环境变量 `CHROME_PATH`：

```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
```

脚本默认 Linux 用 `/usr/bin/google-chrome`，Windows 自动 fallback 到 `%TEMP%\katabump_chrome_data`。

### 5. （可选）配置 WxPusher 微信通知

**5.1 注册 WxPusher**

1. 访问 https://wxpusher.zjiecode.com 注册
2. 创建应用 → 拿到 `appToken`
3. 微信扫码关注公众号 **wxpusher**
4. 访问 https://wxpusher.zjiecode.com/zone 找到你的 `UID`

**5.2 创建配置文件**

复制 `wxpusher.example.json` 为 `wxpusher.json`，填入：

```json
{
  "appToken": "AT_你的真实token",
  "uids": ["UID_你的真实UID"],
  "githubRepo": "nothing688/katabump",
  "githubBranch": "main"
}
```

> `wxpusher.json` 已被加入 `.gitignore`，不会被上传到 GitHub。

**5.3 GitHub 图床准备**

截图会自动上传到你配置的 GitHub 仓库。需确保：

- `gh auth status` 已登录
- Token 有 `repo` scope

默认上传到 `screenshots/YYYY-MM-DD/` 目录。

### 6. 首次运行（手动登录 + 自动保存 cookies）

```powershell
$env:FORCE_RUN = "true"  # 跳过 4 天检查
node action_renew.js
```

应该看到：
- Chrome 启动（窗口在屏幕外）
- 浏览器登录 → 自动写入 cookies 到 `USER_DATA_DIR`
- ALTCHA 自动解 → 续期成功
- 截图上传到 GitHub → WxPusher 推送微信
- 本地截图自动删除

### 7. 配置 Windows 计划任务

打开 PowerShell（**管理员**），执行：

```powershell
$action  = New-ScheduledTaskAction -Execute 'node.exe' -Argument 'c:\path\to\katabump-fork\action_renew.js' -WorkingDirectory 'c:\path\to\katabump-fork'
$trigger = New-ScheduledTaskTrigger -Daily -At '12:00:00'
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
Register-ScheduledTask -TaskName 'Katabump Renew' -Action $action -Trigger $trigger -Settings $settings -User 'SYSTEM' -RunLevel Highest -Force
```

**关键**：`StartWhenAvailable` 让电脑关机时错过 12:00，下次开机自动补跑。

### 8. 验证计划任务

```powershell
Get-ScheduledTask -TaskName 'Katabump Renew' | Format-List TaskName,State,@{N='Trigger';E={$_.Triggers[0].ToString()}},@{N='StartWhenAvailable';E={$_.Settings.StartWhenAvailable}}
```

应看到：

```
TaskName           : Katabump Renew
State              : Ready
StartWhenAvailable : True
```

---

## ☁️ GitHub Actions 云端运行（备选）

如果不想本地跑，也可以用 GitHub Actions。

> **⚠️ 注意**：GitHub Actions 数据中心 IP 容易被 Cloudflare 拦截，需要住宅 IP 代理或 CapSolver 等打码服务。本地方案更稳。

### 1. Fork 仓库

Fork 本仓库到你的 GitHub 账号。

### 2. 配置 Secrets

进入 **Settings → Secrets and variables → Actions**，添加：

| Secret 名 | 格式 |
|----------|------|
| `USERS_JSON` | `[{"username":"...","password":"..."}]` |
| `HTTP_PROXY`（可选） | `http://user:pass@ip:port` |
| `WXPUSHER_APP_TOKEN`（可选） | `AT_xxx` |
| `WXPUSHER_UIDS`（可选） | `UID_xxx`（多个用逗号分隔） |
| `GITHUB_TOKEN` | 自动提供（用于图床） |

### 3. 启用 Workflow

进入 **Actions** 页面启用 `renew.yml`。它会在**每天北京时间 16:00 (UTC 08:00)** 自动运行。

---

## ⚙️ 环境变量参考

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `USERS_JSON` | - | JSON 字符串用户列表（最高优先级） |
| `USERS_CONFIG` | `users.json` | 用户配置文件路径 |
| `WXPUSHER_CONFIG` | `wxpusher.json` | WxPusher 配置文件路径 |
| `CHROME_PATH` | `/usr/bin/google-chrome`（Linux）/ 自动检测（Windows） | Chrome 路径 |
| `CHROME_USER_DATA_DIR` | `%TEMP%/katabump_chrome_data` | Chrome 用户数据目录（持久化登录态） |
| `LAST_RUN_FILE` | `.last_run` | 频率检查时间戳文件 |
| `FORCE_RUN` | - | `true` 跳过 4 天检查 |
| `SHOW_WINDOW` | - | `true` 显示 Chrome 窗口（调试用） |
| `HTTP_PROXY` | - | HTTP 代理 |
| `LOGIN_STATE_FILE` | `login_state.json` | 登录态文件（旧方案，已弃用） |

---

## 🛠️ 项目结构

```
katabump-fork/
├── action_renew.js              # 主脚本（含 WxPusher + GitHub 图床 + 4天检查）
├── renew.js                     # 原项目 Windows 本地脚本（保留兼容）
├── users.json                   # （需创建）账号凭据
├── users.json.example           # 模板
├── wxpusher.json                # （需创建）WxPusher 配置
├── wxpusher.example.json        # 模板
├── .last_run                    # 频率检查时间戳（自动维护）
├── turnstilePatch/              # Turnstile 扩展（修补 MouseEvent.screenX/Y）
│   ├── manifest.json
│   └── script.js
└── .github/workflows/
    └── renew.yml                # GitHub Actions 配置
```

---

## ❓ 常见问题

### 续期失败显示 "Turnstile 验证码连续 3 次未通过"

Cloudflare 检测到当前 IP/环境异常。解决：

1. **本地**：通常不会遇到（家庭 IP 信誉好）。如遇到，关掉所有 Chrome 实例重试。
2. **GitHub Actions**：需要住宅 IP 代理（`HTTP_PROXY` Secret），或 CapSolver 打码。

### 没有收到微信通知

1. 检查 `wxpusher.json` 是否正确填入 `appToken` 和 `uids`
2. 确认已微信扫码关注 **wxpusher** 公众号
3. 确认 zone 页面上能看到你的 UID（https://wxpusher.zjiecode.com/zone）
4. 脚本日志会显示 `[WxPusher] HTTP xxx 响应: {...}`，看具体错误码

### 脚本跳过了，没跑

4 天检查生效，距离上次成功运行 < 4 天会跳过。

```powershell
$env:FORCE_RUN = "true"; node action_renew.js  # 强制运行
```

### Chrome 启动失败

检查 `CHROME_PATH` 环境变量，或直接修改脚本里的默认值。

---

## 📜 License

MIT
