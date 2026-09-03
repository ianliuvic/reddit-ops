import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright';
import { isAllowedNavigationUrl } from './security.js';
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
      context = await chromium.launchPersistentContext(profilePath, {
        headless: false,
        locale: config.locale,
        timezoneId: config.timezone,
        viewport: { width: 1400, height: 940 },
        args: ['--disable-dev-shm-usage', '--password-store=basic'],
        ...(proxyAdapter ? { proxy: proxyAdapter.playwrightProxy } : {}),
      });
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
    await context?.close().catch(() => {});
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
    return { authenticated: hasSessionCookie && !loginPromptVisible, hasSessionCookie, loginPromptVisible };
  }

  return {
    start,
    stop,
    status: () => ({
      state,
      ready: state === 'running',
      lastError,
      startUrl: config.startUrl,
      browser: 'playwright-chromium',
      connection: 'persistent-context',
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
