import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { isAllowedNavigationUrl, normalizeSubredditName } from './security.js';
import { startProxyAdapter } from './proxy.js';

function terminate(child, timeoutMs = 5000) {
  if (!child || child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, timeoutMs);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
    child.kill('SIGTERM');
  });
}

export function createBrowserManager(config) {
  const profilePath = path.join(config.storagePath, 'browser-profile');
  const capturesPath = path.join(config.storagePath, 'captures');
  const storageStatePath = path.join(config.storagePath, 'storage-state.json');
  let context;
  let browser;
  let proxyAdapter;
  let children = [];
  let state = 'stopped';
  let lastError = null;
  let queue = Promise.resolve();
  let stateTimer;

  function service(command, args) {
    const child = spawn(command, args, {
      env: { ...process.env, DISPLAY: config.display },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    child.stderr?.on('data', (chunk) => {
      const message = chunk.toString().trim();
      if (message) process.stderr.write(`[${path.basename(command)}] ${message}\n`);
    });
    children.push(child);
    return child;
  }

  async function waitForChrome(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${config.cdpPort}/json/version`);
        if (response.ok) return;
      } catch { /* Chrome is still starting */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('Google Chrome did not expose its debugging endpoint in time');
  }

  async function saveState() {
    if (context) await context.storageState({ path: storageStatePath });
  }

  function run(task) {
    const current = queue.catch(() => {}).then(async () => {
      if (state !== 'running' || !context) throw new Error('Browser is not ready');
      return task(context.pages()[0] ?? await context.newPage());
    });
    queue = current;
    return current;
  }

  async function start() {
    if (state === 'running') return;
    state = 'starting';
    try {
      await fs.mkdir(profilePath, { recursive: true });
      await fs.mkdir(capturesPath, { recursive: true });
      await Promise.all(['SingletonLock', 'SingletonCookie', 'SingletonSocket']
        .map((name) => fs.rm(path.join(profilePath, name), { force: true, recursive: true })));
      service('fluxbox', []);
      service('x11vnc', ['-display', config.display, '-rfbport', '5900', '-localhost', '-forever', '-shared', '-nopw']);
      service('websockify', ['--web=/usr/share/novnc', '127.0.0.1:6080', '127.0.0.1:5900']);
      proxyAdapter = await startProxyAdapter(config.proxyServer, config.proxyUsername, config.proxyPassword);
      const chromeArgs = [
        `--remote-debugging-port=${config.cdpPort}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profilePath}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--no-sandbox',
        '--disable-dev-shm-usage',
        '--password-store=basic',
        '--window-size=1400,940',
        `--lang=${config.locale}`,
      ];
      if (proxyAdapter) chromeArgs.push(`--proxy-server=${proxyAdapter.playwrightProxy.server}`);
      chromeArgs.push('about:blank');
      service(config.chromePath, chromeArgs);
      await waitForChrome();
      browser = await chromium.connectOverCDP(`http://127.0.0.1:${config.cdpPort}`);
      context = browser.contexts()[0];
      if (!context) throw new Error('Google Chrome did not provide a browser context');
      const page = context.pages()[0] ?? await context.newPage();
      page.setDefaultNavigationTimeout(config.navigationTimeoutMs);
      if (!isAllowedNavigationUrl(page.url())) {
        await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });
      }
      stateTimer = setInterval(() => saveState().catch((error) => { lastError = error.message; }), 15000);
      state = 'running';
      lastError = null;
    } catch (error) {
      lastError = error.message;
      await stop();
      throw error;
    }
  }

  async function stop() {
    clearInterval(stateTimer);
    stateTimer = undefined;
    await saveState().catch(() => {});
    await browser?.close().catch(() => {});
    browser = undefined;
    context = undefined;
    await proxyAdapter?.close().catch(() => {});
    proxyAdapter = undefined;
    await Promise.all(children.reverse().map(terminate));
    children = [];
    state = 'stopped';
  }

  async function loginStatus(page) {
    const cookies = await context.cookies('https://www.reddit.com');
    const hasSessionCookie = cookies.some((cookie) => ['reddit_session', 'token_v2'].includes(cookie.name) && cookie.value);
    const body = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    const loginPromptVisible = /log in|sign up|continue with google/i.test(body.slice(0, 12000));
    let onLoginRoute = false;
    try { onLoginRoute = new URL(page.url()).pathname.startsWith('/login'); } catch { /* non-HTTP page */ }
    return {
      authenticated: hasSessionCookie && !loginPromptVisible && !onLoginRoute,
      hasSessionCookie,
      loginPromptVisible,
      onLoginRoute,
    };
  }

  async function communityInfo(page, requestedName) {
    const name = normalizeSubredditName(requestedName);
    let onReddit = false;
    try { onReddit = new URL(page.url()).hostname.endsWith('reddit.com'); } catch { /* non-HTTP page */ }
    if (!onReddit) await page.goto('https://www.reddit.com/', { waitUntil: 'domcontentloaded' });
    const { ok, payload } = await page.evaluate(async (subreddit) => {
      const response = await fetch(`/r/${encodeURIComponent(subreddit)}/about.json?raw_json=1`, {
        credentials: 'include',
      });
      return { ok: response.ok, payload: await response.json().catch(() => null) };
    }, name);
    if (!ok || !payload?.data) {
      throw new Error(payload?.reason === 'banned' ? 'Subreddit is banned or unavailable' : 'Subreddit not found');
    }
    return {
      name: payload.data.display_name,
      prefixedName: payload.data.display_name_prefixed,
      title: payload.data.title,
      type: payload.data.subreddit_type,
      subscribers: payload.data.subscribers,
      joined: Boolean(payload.data.user_is_subscriber),
      fullname: payload.data.name,
    };
  }

  return {
    start,
    stop,
    status: () => ({
      state,
      ready: state === 'running',
      lastError,
      startUrl: config.startUrl,
      browser: 'google-chrome-stable',
      connection: 'cdp',
      proxy: {
        configured: Boolean(config.proxyServer),
        adapterReady: Boolean(proxyAdapter),
      },
    }),
    openLogin: () => run(async (page) => {
      await page.goto(config.startUrl, { waitUntil: 'domcontentloaded' });
      return { url: page.url(), title: await page.title(), ...(await loginStatus(page)) };
    }),
    navigate: (url) => run(async (page) => {
      if (!isAllowedNavigationUrl(url)) throw new Error('Navigation is limited to Reddit and Google login domains');
      await page.goto(url, { waitUntil: 'domcontentloaded' });
      return { url: page.url(), title: await page.title(), ...(await loginStatus(page)) };
    }),
    snapshot: ({ textLimit = 30000, linkLimit = 200 } = {}) => run(async (page) => ({
      url: page.url(),
      title: await page.title(),
      text: (await page.locator('body').innerText()).slice(0, Math.min(Number(textLimit) || 30000, 100000)),
      links: (await page.locator('a').evaluateAll((nodes, limit) => nodes.slice(0, limit).map((node) => ({
        text: (node.innerText || node.getAttribute('aria-label') || '').trim().slice(0, 300),
        href: node.href,
      })), Math.min(Number(linkLimit) || 200, 500))).filter((item) => item.href),
      ...(await loginStatus(page)),
    })),
    community: (name) => run(async (page) => communityInfo(page, name)),
    joinCommunity: (requestedName, approval) => run(async (page) => {
      const name = normalizeSubredditName(requestedName);
      if (approval !== `JOIN r/${name}`) throw new Error(`Approval must equal JOIN r/${name}`);

      const login = await loginStatus(page);
      if (!login.authenticated) throw new Error('Reddit login is required');

      const before = await communityInfo(page, name);
      if (!['public', 'restricted'].includes(before.type)) {
        throw new Error('Only public or restricted subreddits can be joined');
      }
      if (before.joined) return { changed: false, community: before };

      await page.goto(`https://www.reddit.com/r/${name}/`, { waitUntil: 'domcontentloaded' });
      const result = await page.evaluate(async ({ fullname, displayName }) => {
        const meResponse = await fetch('/api/me.json', { credentials: 'include' });
        const me = await meResponse.json();
        const modhash = me?.data?.modhash;
        if (!meResponse.ok || !me?.data?.name || !modhash) throw new Error('Could not authorize Reddit membership change');

        const form = new URLSearchParams({
          api_type: 'json',
          action: 'sub',
          sr: fullname,
          uh: modhash,
        });
        const response = await fetch('/api/subscribe', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Modhash': modhash,
          },
          body: form.toString(),
        });
        const text = await response.text();
        let payload = null;
        try { payload = text ? JSON.parse(text) : null; } catch { /* Reddit may return an empty body */ }
        if (!response.ok || payload?.json?.errors?.length) {
          throw new Error(`Reddit rejected joining r/${displayName}`);
        }
        return { account: me.data.name };
      }, { fullname: before.fullname, displayName: before.name });

      const after = await communityInfo(page, name);
      if (!after.joined) throw new Error(`Reddit did not confirm membership in r/${after.name}`);
      await saveState();
      return { changed: true, account: result.account, community: after };
    }),
    screenshot: ({ fullPage = false } = {}) => run(async (page) => {
      const name = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomUUID()}.png`;
      const target = path.join(capturesPath, name);
      await page.screenshot({ path: target, fullPage: Boolean(fullPage) });
      return { name, path: target, url: page.url(), title: await page.title() };
    }),
    capturePath: (name) => {
      if (!/^[0-9TZa-z.-]+\.png$/.test(name)) throw new Error('Invalid capture name');
      return path.join(capturesPath, name);
    },
  };
}
