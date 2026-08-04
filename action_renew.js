const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { spawn, exec } = require('child_process');
const http = require('http');
const net = require('net');

const TG_BOT_TOKEN = process.env.TG_BOT_TOKEN;
const TG_CHAT_ID = process.env.TG_CHAT_ID;

// 全局截图目录（提前初始化，避免后面各分支引用未定义）
const photoDir = path.join(process.cwd(), 'screenshots');
if (!fs.existsSync(photoDir)) fs.mkdirSync(photoDir, { recursive: true });

async function sendTelegramMessage(message, imagePath = null) {
    if (!TG_BOT_TOKEN || !TG_CHAT_ID) return;

    // 1. 发送文字消息
    try {
        const url = `https://api.telegram.org/bot${TG_BOT_TOKEN}/sendMessage`;
        await axios.post(url, {
            chat_id: TG_CHAT_ID,
            text: message,
            parse_mode: 'Markdown'
        });
        console.log('[Telegram] Message sent.');
    } catch (e) {
        console.error('[Telegram] Failed to send message:', e.message);
    }

    // 2. 发送图片 (如果有)
    if (imagePath && fs.existsSync(imagePath)) {
        console.log('[Telegram] Sending photo...');
        // 使用 curl 发送图片，避免引入额外的 multipart 依赖
        // 注意：Windows 本地测试可能需要环境支持 curl，GitHub Actions (Ubuntu) 默认支持
        const cmd = `curl -s -X POST "https://api.telegram.org/bot${TG_BOT_TOKEN}/sendPhoto" -F chat_id="${TG_CHAT_ID}" -F photo="@${imagePath}"`;
        await new Promise(resolve => {
            exec(cmd, (err) => {
                if (err) console.error('[Telegram] Failed to send photo via curl:', err.message);
                else console.log('[Telegram] Photo sent.');
                resolve();
            });
        });
    }
}

// 启用 stealth 插件
chromium.use(stealth);

// GitHub Actions 环境下的 Chrome 路径 (通常是 google-chrome)
const CHROME_PATH = process.env.CHROME_PATH || '/usr/bin/google-chrome';
const DEBUG_PORT = 9222;

// 确保 localhost 不走代理
process.env.NO_PROXY = 'localhost,127.0.0.1';

// --- Proxy Configuration ---
const HTTP_PROXY = (process.env.HTTP_PROXY || '').trim();
let PROXY_CONFIG = null;

if (HTTP_PROXY) {
    try {
        const proxyUrl = new URL(HTTP_PROXY);
        PROXY_CONFIG = {
            server: `${proxyUrl.protocol}//${proxyUrl.hostname}:${proxyUrl.port}`,
            username: proxyUrl.username ? decodeURIComponent(proxyUrl.username) : undefined,
            password: proxyUrl.password ? decodeURIComponent(proxyUrl.password) : undefined
        };
        console.log(`[代理] 检测到配置: 服务器=${PROXY_CONFIG.server}, 认证=${PROXY_CONFIG.username ? '是' : '否'}`);
    } catch (e) {
        console.error('[代理] TODO HTTP_PROXY 格式无效。期望格式: http://user:pass@host:port 或 http://host:port');
        process.exit(1);
    }
}

// --- INJECTED_SCRIPT ---
const INJECTED_SCRIPT = `
(function() {
    if (window.self === window.top) return;

    // 1. 模拟鼠标屏幕坐标
    try {
        function getRandomInt(min, max) {
            return Math.floor(Math.random() * (max - min + 1)) + min;
        }
        let screenX = getRandomInt(800, 1200);
        let screenY = getRandomInt(400, 600);
        
        Object.defineProperty(MouseEvent.prototype, 'screenX', { value: screenX });
        Object.defineProperty(MouseEvent.prototype, 'screenY', { value: screenY });
    } catch (e) { }

    // 2. 简单的 attachShadow Hook
    try {
        const originalAttachShadow = Element.prototype.attachShadow;
        
        Element.prototype.attachShadow = function(init) {
            const shadowRoot = originalAttachShadow.call(this, init);
            
            if (shadowRoot) {
                const checkAndReport = () => {
                    const checkbox = shadowRoot.querySelector('input[type="checkbox"]');
                    if (checkbox) {
                        const rect = checkbox.getBoundingClientRect();
                        if (rect.width > 0 && rect.height > 0 && window.innerWidth > 0 && window.innerHeight > 0) {
                            const xRatio = (rect.left + rect.width / 2) / window.innerWidth;
                            const yRatio = (rect.top + rect.height / 2) / window.innerHeight;
                            window.__turnstile_data = { xRatio, yRatio };
                            return true;
                        }
                    }
                    return false;
                };

                if (!checkAndReport()) {
                    const observer = new MutationObserver(() => {
                        if (checkAndReport()) observer.disconnect();
                    });
                    observer.observe(shadowRoot, { childList: true, subtree: true });
                }
            }
            return shadowRoot;
        };
    } catch (e) {
        console.error('[注入] Hook attachShadow 失败:', e);
    }
})();
`;

// 辅助函数：检测代理是否可用
async function checkProxy() {
    if (!PROXY_CONFIG) return true;

    console.log('[代理] 正在验证代理连接...');
    try {
        const axiosConfig = {
            proxy: {
                protocol: 'http',
                host: new URL(PROXY_CONFIG.server).hostname,
                port: new URL(PROXY_CONFIG.server).port,
            },
            timeout: 10000
        };

        if (PROXY_CONFIG.username && PROXY_CONFIG.password) {
            axiosConfig.proxy.auth = {
                username: PROXY_CONFIG.username,
                password: PROXY_CONFIG.password
            };
        }

        await axios.get('https://www.google.com', axiosConfig);
        console.log('[代理] 连接成功！');
        return true;
    } catch (error) {
        console.error(`[代理] 连接失败: ${error.message}`);
        return false;
    }
}

// 修复 1：改用 TCP 直连测试端口，彻底绕开 Node 20 URL 解析 bug 和 GitHub 编辑器破坏模板字符串问题
function checkPort(port) {
    return new Promise((resolve) => {
        const portNum = parseInt(String(port).replace(/\D/g, ''), 10);
        if (!portNum || portNum < 1 || portNum > 65535) {
            return resolve(false);
        }
        const socket = new net.Socket();
        socket.setTimeout(3000);
        socket.once('connect', () => { socket.destroy(); resolve(true); });
        socket.once('error', () => { socket.destroy(); resolve(false); });
        socket.once('timeout', () => { socket.destroy(); resolve(false); });
        socket.connect(portNum, '127.0.0.1');
    });
}

// 修复 2：捕获 Chrome 输出并强制 IPv4 绑定，便于诊断启动失败
async function launchChrome() {
    // 修复 DBus 在容器/Actions 里连接失败的问题
    process.env.DBUS_SESSION_BUS_ADDRESS = '/dev/null';
    process.env.CHROME_DEVEL_SANDBOX = '';

    console.log('检查 Chrome 是否已在端口 ' + DEBUG_PORT + ' 上运行...');
    if (await checkPort(DEBUG_PORT)) {
        console.log('Chrome 已开启。');
        return;
    }

    console.log(`正在启动 Chrome (路径: ${CHROME_PATH})...`);

    if (!fs.existsSync(CHROME_PATH)) {
        throw new Error('Chrome 文件不存在: ' + CHROME_PATH);
    }

    const args = [
        `--remote-debugging-port=${DEBUG_PORT}`,
        '--remote-debugging-address=127.0.0.1', // 强制绑定 IPv4，避免 IPv6 解析问题
        '--no-first-run',
        '--no-default-browser-check',
        // '--headless=new', // (已被注释) 使用 xvfb-run 时不需要 headless 模式，这样可以模拟有头浏览器增加成功率
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--window-size=1280,720',
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // 避免共享内存不足
        '--disable-background-networking',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-blink-features=AutomationControlled',
        '--no-zygote',
        '--user-data-dir=/tmp/chrome_user_data', // 必须指定用户数据目录，否则远程调试可能失败
        // 加载 turnstilePatch 扩展, 修补 screenX/screenY 让 Turnstile 走 auto 模式
        `--load-extension=${path.join(__dirname, 'turnstilePatch')}`,
        `--disable-extensions-except=${path.join(__dirname, 'turnstilePatch')}`
    ];

    if (PROXY_CONFIG) {
        args.push(`--proxy-server=${PROXY_CONFIG.server}`);
        args.push('--proxy-bypass-list=<-loopback>');
    }

    console.log('[launchChrome] 启动参数: ' + JSON.stringify(args));

    const chrome = spawn(CHROME_PATH, args, {
        detached: false,
        stdio: ['ignore', 'pipe', 'pipe']
    });

    chrome.stdout.on('data', (d) => { process.stdout.write('[chrome-out] ' + d); });
    chrome.stderr.on('data', (d) => { process.stderr.write('[chrome-err] ' + d); });
    chrome.on('error', (e) => { console.log('[chrome-spawn-error] ' + e.message); });
    chrome.on('exit', (c, s) => { console.log('[chrome-exit] code=' + c + ' sig=' + s); });

    console.log('正在等待 Chrome 初始化...');
    for (let i = 0; i < 30; i++) {
        if (await checkPort(DEBUG_PORT)) break;
        await new Promise(r => setTimeout(r, 1000));
    }

    if (!await checkPort(DEBUG_PORT)) {
        console.error('Chrome 无法在端口 ' + DEBUG_PORT + ' 上启动');
        throw new Error('Chrome 启动失败');
    }

    console.log('Chrome 启动成功。');
}

function getUsers() {
    // 从环境变量读取 JSON 字符串
    // GitHub Actions Secret: USERS_JSON = [{"username":..., "password":...}]
    try {
        if (process.env.USERS_JSON) {
            const parsed = JSON.parse(process.env.USERS_JSON);
            return Array.isArray(parsed) ? parsed : (parsed.users || []);
        }
    } catch (e) {
        console.error('解析 USERS_JSON 环境变量错误:', e);
    }
    return [];
}

async function attemptTurnstileCdp(page) {
    const frames = page.frames();
    for (const frame of frames) {
        try {
            const data = await frame.evaluate(() => window.__turnstile_data).catch(() => null);

            if (data) {
                console.log('>> 在 frame 中发现 Turnstile。比例:', data);

                const iframeElement = await frame.frameElement();
                if (!iframeElement) continue;

                const box = await iframeElement.boundingBox();
                if (!box) continue;

                // 修复 11+12：尝试多个点击位置
                // Turnstile 的视觉方框通常在 iframe 左侧，而注入脚本可能指向隐藏的 input
                const candidatePoints = [];
                // 位置 1：iframe 左侧视觉方框（基于截图估算：左边缘 + 30px, 垂直中心）
                candidatePoints.push({ x: box.x + 30 + Math.random() * 10, y: box.y + box.height * 0.5 + (Math.random() - 0.5) * 10, label: 'visual-checkbox-left' });
                // 位置 2：注入脚本计算的位置
                candidatePoints.push({ x: box.x + (box.width * data.xRatio) + (Math.random() - 0.5) * 8, y: box.y + (box.height * data.yRatio) + (Math.random() - 0.5) * 8, label: 'injected-ratio' });
                // 位置 3：iframe 左侧更偏中间
                candidatePoints.push({ x: box.x + 45 + Math.random() * 10, y: box.y + box.height * 0.5 + (Math.random() - 0.5) * 10, label: 'visual-checkbox-left-2' });

                // 方法 A：Playwright 原生鼠标移动 + 点击
                try {
                    for (const point of candidatePoints) {
                        console.log(`>> 尝试点击位置 [${point.label}]: (${point.x.toFixed(2)}, ${point.y.toFixed(2)})`);

                        const startX = Math.random() * 300 + 100;
                        const startY = Math.random() * 300 + 100;
                        await page.mouse.move(startX, startY);
                        await page.waitForTimeout(100 + Math.random() * 200);

                        const steps = 10 + Math.floor(Math.random() * 6);
                        for (let i = 1; i <= steps; i++) {
                            const t = i / steps;
                            const easeT = t * t * (3 - 2 * t);
                            const mx = startX + (point.x - startX) * easeT + (Math.random() - 0.5) * 15;
                            const my = startY + (point.y - startY) * easeT + (Math.random() - 0.5) * 15;
                            await page.mouse.move(mx, my);
                            await page.waitForTimeout(30 + Math.random() * 50);
                        }

                        await page.waitForTimeout(150 + Math.random() * 200);
                        await page.mouse.click(point.x + (Math.random() - 0.5) * 4, point.y + (Math.random() - 0.5) * 4);
                        await page.waitForTimeout(200 + Math.random() * 200);
                        await page.mouse.move(point.x + 50 + Math.random() * 50, point.y + (Math.random() - 0.5) * 50);

                        // 每次点击后等待 2-3 秒，检查是否成功
                        await page.waitForTimeout(2500);
                        let successNow = false;
                        const checkFrames = page.frames();
                        for (const f of checkFrames) {
                            if (f.url().includes('cloudflare')) {
                                try {
                                    const successEn = await f.getByText('Success!', { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
                                    const successCn = await f.getByText('成功', { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
                                    if (successEn || successCn) {
                                        console.log(`>> 位置 [${point.label}] 点击成功，Turnstile 已验证。`);
                                        successNow = true;
                                        break;
                                    }
                                } catch (e) { }
                            }
                        }
                        if (successNow) return true;

                        console.log(`>> 位置 [${point.label}] 未触发成功，尝试下一个位置...`);
                    }

                    console.log('>> Playwright 所有位置尝试完毕，均未触发成功。');
                } catch (mouseErr) {
                    console.log('>> Playwright 鼠标点击失败:', mouseErr.message);
                }

                return false;
            }
        } catch (e) { }
    }
    return false;
}

// 修复 6：智能查找 dashboard 上的 "See" / "View" / "Details" / "Renew" 入口
async function findAndClickDashboardAction(page, safeUsername) {
    const candidates = [
        { role: 'link', name: 'See', exact: false },
        { role: 'link', name: /see/i, regex: true },
        { role: 'button', name: 'See', exact: false },
        { role: 'link', name: 'View', exact: false },
        { role: 'link', name: 'Details', exact: false },
        { role: 'button', name: 'View', exact: false },
        { role: 'button', name: 'Details', exact: false },
        { role: 'link', name: 'Renew', exact: false }
    ];

    for (const cand of candidates) {
        try {
            let locator;
            if (cand.regex) {
                locator = page.getByRole(cand.role, { name: cand.name }).first();
            } else {
                locator = page.getByRole(cand.role, { name: cand.name, exact: cand.exact }).first();
            }
            await locator.waitFor({ state: 'visible', timeout: 3000 });
            await page.waitForTimeout(500);
            await locator.click();
            console.log(`[Dashboard] 点击成功: role=${cand.role}, name=${cand.name}`);
            return true;
        } catch (e) {
            // 继续尝试下一个候选
        }
    }

    // 兜底：用 CSS + innerText 查找包含 "See" / "Renew" / "View" / "Details" 的可点击元素
    try {
        const selectors = ['a', 'button', '[role="button"]', '[role="link"]'];
        for (const sel of selectors) {
            const found = await page.locator(sel).filter({ hasText: /see|view|details|renew/i }).first();
            if (await found.isVisible({ timeout: 2000 })) {
                await found.click();
                console.log('[Dashboard] 兜底选择器点击成功: ' + sel);
                return true;
            }
        }
    } catch (e) { }

    // 全部失败：截图 + 打印页面信息
    console.log('[Dashboard] 未找到任何已知的 dashboard 入口按钮');
    try {
        const debugShot = path.join(photoDir, `${safeUsername}_dashboard_no_action.png`);
        await page.screenshot({ path: debugShot, fullPage: true, timeout: 15000 });
        console.log('[Dashboard] 调试截图: ' + debugShot);
        console.log('[Dashboard] 当前 URL: ' + page.url());
        console.log('[Dashboard] 当前标题: ' + await page.title());
        const links = await page.$$eval('a', as => as.map(a => a.innerText.trim()).filter(t => t));
        const buttons = await page.$$eval('button', bs => bs.map(b => b.innerText.trim()).filter(t => t));
        console.log('[Dashboard] 页面所有链接文本: ' + JSON.stringify(links));
        console.log('[Dashboard] 页面所有按钮文本: ' + JSON.stringify(buttons));
    } catch (e) { }

    return false;
}

(async () => {
    const users = getUsers();
    if (users.length === 0) {
        console.log('未在 process.env.USERS_JSON 中找到用户');
        process.exit(1);
    }

    if (PROXY_CONFIG) {
        const isValid = await checkProxy();
        if (!isValid) {
            console.error('[代理] 代理无效，终止运行。');
            process.exit(1);
        }
    }

    await launchChrome();

    console.log(`正在连接 Chrome...`);
    let browser;
    for (let k = 0; k < 5; k++) {
        try {
            // 修复 3：CDP 连接也使用 127.0.0.1
            browser = await chromium.connectOverCDP(`http://127.0.0.1:${DEBUG_PORT}`);
            console.log('连接成功！');
            break;
        } catch (e) {
            console.log(`连接尝试 ${k + 1} 失败。2秒后重试...`);
            await new Promise(r => setTimeout(r, 2000));
        }
    }

    if (!browser) {
        console.error('连接失败。退出。');
        process.exit(1);
    }

    const context = browser.contexts()[0];
    let page = context.pages().length > 0 ? context.pages()[0] : await context.newPage();
    page.setDefaultTimeout(60000);

    if (PROXY_CONFIG && PROXY_CONFIG.username) {
        console.log('[代理] 正在设置认证...');
        await context.setHTTPCredentials({
            username: PROXY_CONFIG.username,
            password: PROXY_CONFIG.password
        });
    } else {
        await context.setHTTPCredentials(null);
    }

    await page.addInitScript(INJECTED_SCRIPT);
    console.log('注入脚本已添加。');

    for (let i = 0; i < users.length; i++) {
        const user = users[i];
        // 修复 4：提前定义 safeUsername，避免登录失败截图处引用未定义
        const safeUsername = user.username.replace(/[^a-z0-9]/gi, '_');
        console.log(`\n=== 正在处理用户 ${i + 1}/${users.length} ===`);

        try {
            if (page.isClosed()) {
                page = await context.newPage();
                await page.addInitScript(INJECTED_SCRIPT);
            }

            // === 登录态复用：优先用已保存的登录态，跳过登录和验证码 ===
            let loginSuccess = false;
            let useLoginState = false;
            try {
                const loginStateRaw = process.env.LOGIN_STATE || (fs.existsSync('login_state.json') ? fs.readFileSync('login_state.json', 'utf8') : null);
                if (loginStateRaw) {
                    const state = JSON.parse(loginStateRaw);
                    if (state.cookies && state.cookies.length) {
                        await context.clearCookies();
                        await context.addCookies(state.cookies);
                        await page.goto('https://dashboard.katabump.com/dashboard');
                        await page.waitForTimeout(4000);
                        if (!page.url().includes('/auth/login')) {
                            console.log('>>> 登录态有效！跳过登录和验证码，直接进入 dashboard');
                            useLoginState = true;
                            loginSuccess = true;
                        } else {
                            console.log('>>> 登录态已过期，将走正常登录流程');
                        }
                    }
                }
            } catch (e) {
                console.log('登录态处理失败:', e.message);
            }

            if (!useLoginState) {
            // --- 登录逻辑 ---
            if (page.url().includes('dashboard')) {
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
            }
            // 总是先去登录页
            await page.goto('https://dashboard.katabump.com/auth/login');
            await page.waitForTimeout(2000);
            if (page.url().includes('dashboard')) {
                // 如果登出没成功，再次登出
                await page.goto('https://dashboard.katabump.com/auth/logout');
                await page.waitForTimeout(2000);
                await page.goto('https://dashboard.katabump.com/auth/login');
            }

            // 修复 7：登录支持 Turnstile 失败重试
            for (let loginAttempt = 1; loginAttempt <= 3; loginAttempt++) {
                console.log(`\n[登录尝试 ${loginAttempt}/3] 正在输入凭据...`);
                try {
                    // 修复 8：支持中英文登录页（Email/电子邮件、Password/密码、Login/登录）
                    let emailInput;
                    try {
                        emailInput = page.getByRole('textbox', { name: 'Email' });
                        await emailInput.waitFor({ state: 'visible', timeout: 3000 });
                    } catch (e) {
                        emailInput = page.getByRole('textbox', { name: '电子邮件' });
                        await emailInput.waitFor({ state: 'visible', timeout: 7000 });
                    }
                    await emailInput.fill(user.username);

                    let pwdInput;
                    try {
                        pwdInput = page.getByRole('textbox', { name: 'Password' });
                        await pwdInput.waitFor({ state: 'visible', timeout: 3000 });
                    } catch (e) {
                        pwdInput = page.getByRole('textbox', { name: '密码' });
                        await pwdInput.waitFor({ state: 'visible', timeout: 7000 });
                    }
                    await pwdInput.fill(user.password);
                    await page.waitForTimeout(800);

                    // --- Cloudflare Turnstile Bypass for Login ---
                    console.log('   >> 正在登录前检查 Turnstile (使用 CDP 绕过)...');
                    let cdpClickResult = false;
                    for (let findAttempt = 0; findAttempt < 5; findAttempt++) {
                        cdpClickResult = await attemptTurnstileCdp(page);
                        if (cdpClickResult) break;
                        await page.waitForTimeout(1000);
                    }

                    if (cdpClickResult) {
                        console.log('   >> 登录 CDP 点击生效。正在等待 Cloudflare 成功标志...');
                        let successDetected = false;
                        for (let waitSec = 0; waitSec < 15; waitSec++) {
                            const frames = page.frames();
                            for (const f of frames) {
                                if (f.url().includes('cloudflare')) {
                                    try {
                                        // 同时支持英文 Success! 和中文 成功！
                                        const successEn = await f.getByText('Success!', { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
                                        const successCn = await f.getByText('成功', { exact: false }).isVisible({ timeout: 300 }).catch(() => false);
                                        if (successEn || successCn) {
                                            console.log('   >> 登录前 Turnstile 验证成功。');
                                            successDetected = true;
                                            break;
                                        }
                                    } catch (e) { }
                                }
                            }
                            if (successDetected) break;
                            await page.waitForTimeout(1000);
                        }
                        if (!successDetected) {
                            console.log('   >> 警告：未检测到 Success!/成功!，但将继续尝试登录');
                        }
                    } else {
                        console.log('   >> 登录前未检测到 Turnstile，继续操作...');
                    }
                    // --------------------------------------------

                    // 点击登录按钮（支持 Login / 登录）
                    let loginBtn;
                    try {
                        loginBtn = page.getByRole('button', { name: 'Login', exact: true });
                        await loginBtn.waitFor({ state: 'visible', timeout: 3000 });
                    } catch (e) {
                        loginBtn = page.getByRole('button', { name: '登录', exact: true });
                        await loginBtn.waitFor({ state: 'visible', timeout: 5000 });
                    }
                    await loginBtn.click();

                    // 等待页面跳转
                    console.log('   >> 等待登录结果...');
                    await page.waitForTimeout(4000);

                    // 检查账号密码错误（支持中英文）
                    try {
                        let errorMsg;
                        try {
                            errorMsg = page.getByText('Incorrect password or no account');
                            await errorMsg.waitFor({ state: 'visible', timeout: 2000 });
                        } catch (e) {
                            errorMsg = page.getByText(/密码错误|账号不存在|Incorrect|invalid/i);
                            await errorMsg.waitFor({ state: 'visible', timeout: 2000 });
                        }
                        if (await errorMsg.isVisible({ timeout: 1000 })) {
                            console.error(`   >> 登录失败: 用户 ${user.username} 账号或密码错误`);
                            const failShotPath = path.join(photoDir, `${safeUsername}.png`);
                            try { await page.screenshot({ path: failShotPath, fullPage: true, timeout: 15000 }); } catch (e) { }

                            await sendTelegramMessage(`登录失败\n用户: ${user.username}\n原因: 账号或密码错误`, failShotPath);

                            loginSuccess = false;
                            break; // 密码错误不用重试
                        }
                    } catch (e) { }

                    const currentUrl = page.url();
                    const currentTitle = await page.title();
                    console.log('   >> 当前 URL: ' + currentUrl);
                    console.log('   >> 当前标题: ' + currentTitle);

                    // 检查是否登录成功
                    if (!currentUrl.includes('/auth/login')) {
                        console.log('   >> 登录成功，已离开登录页。');
                        loginSuccess = true;
                        break;
                    }

                    // 还在登录页，分析原因
                    if (currentUrl.includes('error=captcha')) {
                        console.log('   >> 登录失败：验证码未通过 (error=captcha)，准备重试...');
                        const captchaShot = path.join(photoDir, `${safeUsername}_captcha_fail_${loginAttempt}.png`);
                        try { await page.screenshot({ path: captchaShot, fullPage: true, timeout: 15000 }); } catch (e) { }

                        if (loginAttempt < 3) {
                            console.log('   >> 刷新页面后重试登录...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        } else {
                            console.error('   >> 验证码重试 3 次均失败，跳过该用户。');
                            await sendTelegramMessage(`登录失败\n用户: ${user.username}\n原因: Turnstile 验证码连续 3 次未通过`, captchaShot);
                            loginSuccess = false;
                            break;
                        }
                    }

                    // 其他原因仍在登录页
                    console.log('   >> 登录后仍在登录页，可能登录失败或需要额外验证');
                    const loginDebugShot = path.join(photoDir, `${safeUsername}_login_stuck_${loginAttempt}.png`);
                    try { await page.screenshot({ path: loginDebugShot, fullPage: true, timeout: 15000 }); } catch (e) { }

                    if (loginAttempt < 3) {
                        console.log('   >> 刷新后重试...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }
                    loginSuccess = false;
                    break;

                } catch (e) {
                    console.log('登录错误:', e.message);
                    if (loginAttempt < 3) {
                        console.log('   >> 刷新后重试...');
                        try { await page.reload(); } catch (e2) { }
                        await page.waitForTimeout(3000);
                        continue;
                    }
                    loginSuccess = false;
                    break;
                }
            }
            } // end if (!useLoginState)

            if (!loginSuccess) {
                console.log('登录未成功，跳过 dashboard 入口查找。');
                continue;
            }

            // 修复 5：等待 dashboard 加载，然后用智能函数查找入口
            console.log('正在寻找 dashboard 入口 (See/View/Details/Renew)...');
            const dashboardLoaded = await findAndClickDashboardAction(page, safeUsername);
            if (!dashboardLoaded) {
                console.log('未找到 dashboard 入口，跳过该用户。');
                continue;
            }

            // --- Renew 逻辑 ---
            let renewSuccess = false;
            for (let attempt = 1; attempt <= 20; attempt++) {
                let hasCaptchaError = false;

                console.log(`\n[尝试 ${attempt}/20] 正在寻找 Renew 按钮...`);

                const renewBtn = page.getByRole('button', { name: 'Renew', exact: true }).first();
                try {
                    await renewBtn.waitFor({ state: 'visible', timeout: 5000 });
                } catch (e) { }

                if (await renewBtn.isVisible()) {
                    await renewBtn.click();
                    console.log('Renew 按钮已点击。等待模态框...');

                    const modal = page.locator('#renew-modal');
                    try { await modal.waitFor({ state: 'visible', timeout: 5000 }); } catch (e) {
                        console.log('模态框未出现？重试中...');
                        continue;
                    }

                    // A. 在模态框里晃晃鼠标
                    try {
                        const box = await modal.boundingBox();
                        if (box) await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 5 });
                    } catch (e) { }

                    // B. 处理 ALTCHA 验证码 (续期模态框使用 ALTCHA, 非 Turnstile)
                    console.log('正在处理 ALTCHA 验证码...');
                    let altchaOk = false;
                    try {
                        // 1. JS 触发 checkbox 原生 click (无视 CSS 隐藏)
                        const clickRes = await page.evaluate(() => {
                            const input = document.querySelector('.altcha-checkbox input[type=checkbox]');
                            if (!input) return 'no-checkbox';
                            if (!input.checked) { input.click(); return 'clicked'; }
                            return 'already-checked';
                        });
                        console.log('   >> ALTCHA checkbox:', clickRes);

                        // 2. 等待 widget 计算 PoW 并填入 token
                        for (let i = 0; i < 20; i++) {
                            await page.waitForTimeout(1000);
                            const token = await page.evaluate(() => {
                                const input = document.querySelector('input[name="altcha"]');
                                return (input && input.value && input.value.length > 20) ? input.value : null;
                            });
                            if (token) {
                                console.log(`   >> ALTCHA 验证通过 (耗时 ${i + 1}s)`);
                                altchaOk = true;
                                break;
                            }
                        }
                    } catch (e) {
                        console.log('   >> ALTCHA 处理出错:', e.message);
                    }
                    if (!altchaOk) {
                        console.log('   >> ALTCHA 未在预期时间内通过，尝试直接提交...');
                    }

                    // D. 准备点击确认
                    const confirmBtn = modal.getByRole('button', { name: 'Renew' });
                    if (await confirmBtn.isVisible()) {

                        // Screenshot BEFORE final click
                        const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                        const tsScreenshotName = `${safeUser}_Turnstile_${attempt}.png`;
                        try {
                            await page.screenshot({ path: path.join(photoDir, tsScreenshotName), fullPage: true, timeout: 15000 });
                            console.log(`   >> 快照已保存: ${tsScreenshotName}`);
                        } catch (e) { }

                        console.log('   >> 点击 Renew 确认按钮 (无论 Turnstile 状态如何)...');
                        await confirmBtn.click();

                        try {
                            // 1. Check for Errors (Captcha or Date limit)
                            const startVerifyTime = Date.now();
                            while (Date.now() - startVerifyTime < 3000) {
                                // A. Captcha Error
                                if (await page.getByText('Please complete the captcha to continue').isVisible()) {
                                    console.log('   >> 检测到错误: "Please complete the captcha".');
                                    hasCaptchaError = true;
                                    break;
                                }

                                // B. Not Renew Time Error
                                const notTimeLoc = page.getByText("You can't renew your server yet");
                                if (await notTimeLoc.isVisible()) {
                                    const text = await notTimeLoc.innerText();
                                    const match = text.match(/as of\s+(.*?)\s+\(/);
                                    let dateStr = match ? match[1] : 'Unknown Date';
                                    console.log(`   >> 暂无法续期。下次可用时间: ${dateStr}`);

                                    // 截图证明
                                    const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                                    const skipShotPath = path.join(photoDir, `${safeUser}_skip.png`);
                                    try { await page.screenshot({ path: skipShotPath, fullPage: true, timeout: 15000 }); } catch (e) { }

                                    await sendTelegramMessage(`暂无法续期 (跳过)\n用户: ${user.username}\n原因: 还没到时间\n下次可用: ${dateStr}`, skipShotPath);

                                    renewSuccess = true; // Mark as done to stop retries
                                    try {
                                        const closeBtn = modal.getByLabel('Close');
                                        if (await closeBtn.isVisible()) await closeBtn.click();
                                    } catch (e) { }
                                    break;
                                }
                                await page.waitForTimeout(200);
                            }
                        } catch (e) { }

                        if (renewSuccess) break; // Break loop if not time yet

                        if (hasCaptchaError) {
                            console.log('   >> Error found. Refreshing page to reset Turnstile...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue; // 刷新后，重新开始大循环
                        }

                        // F. 检查成功 (模态框消失)
                        await page.waitForTimeout(2000);
                        if (!await modal.isVisible()) {
                            console.log('   >> Modal closed. Renew successful!');

                            // 截图成功状态
                            const safeUser = user.username.replace(/[^a-z0-9]/gi, '_');
                            const successShotPath = path.join(photoDir, `${safeUser}_success.png`);
                            try { await page.screenshot({ path: successShotPath, fullPage: true, timeout: 15000 }); } catch (e) { }

                            await sendTelegramMessage(`续期成功\n用户: ${user.username}\n状态: 服务器已成功续期！`, successShotPath);
                            renewSuccess = true;
                            break;
                        } else {
                            console.log('   >> 模态框仍打开但无错误？重试循环...');
                            await page.reload();
                            await page.waitForTimeout(3000);
                            continue;
                        }
                    } else {
                        console.log('   >> 未找到模态框内的验证按钮？刷新中...');
                        await page.reload();
                        await page.waitForTimeout(3000);
                        continue;
                    }

                } else {
                    console.log('未找到 Renew 按钮 (服务器可能已续期或页面加载错误)。');
                    break;
                }
            }
        } catch (err) {
            console.error(`Error processing user:`, err);
        }

        // Snapshot before handling next user
        const screenshotPath = path.join(photoDir, `${safeUsername}.png`);
        try {
            await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 15000 });
            console.log(`截图已保存至: ${screenshotPath}`);
        } catch (e) {
            console.log('截图失败:', e.message);
        }

        console.log(`用户处理完成\n`);
    }

    console.log('完成。');
    await browser.close();
    process.exit(0);
})();
