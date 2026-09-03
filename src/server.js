import fs from 'node:fs/promises';
import Fastify from 'fastify';
import fastifyHttpProxy from '@fastify/http-proxy';
import { createBrowserManager } from './browser.js';
import { safeEqual } from './security.js';

const config = {
  port: Number(process.env.PORT ?? 3000),
  storagePath: process.env.STORAGE_PATH ?? '/app/storage',
  adminApiKey: process.env.ADMIN_API_KEY ?? '',
  novncUsername: process.env.NOVNC_USERNAME ?? '',
  novncPassword: process.env.NOVNC_PASSWORD ?? '',
  publicHost: process.env.LOGIN_PUBLIC_HOST ?? 'reddit-ops.yiswim.cloud',
  startUrl: process.env.REDDIT_START_URL ?? 'https://www.reddit.com/login/',
  locale: process.env.BROWSER_LOCALE ?? 'en-US',
  timezone: process.env.BROWSER_TIMEZONE ?? 'America/New_York',
  navigationTimeoutMs: Number(process.env.NAVIGATION_TIMEOUT_MS ?? 60000),
  display: process.env.DISPLAY ?? ':99',
};
if (!config.adminApiKey) throw new Error('ADMIN_API_KEY is required');
if (!config.novncUsername || !config.novncPassword) throw new Error('NOVNC_USERNAME and NOVNC_PASSWORD are required');

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1024 * 1024 });
const browser = createBrowserManager(config);

function apiAuth(request, reply, done) {
  const supplied = request.headers.authorization?.replace(/^Bearer\s+/i, '') ?? '';
  if (!safeEqual(supplied, config.adminApiKey)) return reply.code(401).send({ error: 'unauthorized' });
  done();
}

function novncAuth(request, reply, done) {
  const encoded = request.headers.authorization?.match(/^Basic\s+(.+)$/i)?.[1] ?? '';
  let supplied = '';
  try { supplied = Buffer.from(encoded, 'base64').toString('utf8'); } catch { /* no-op */ }
  if (!safeEqual(supplied, `${config.novncUsername}:${config.novncPassword}`)) {
    reply.header('WWW-Authenticate', 'Basic realm="Reddit Ops Login"');
    return reply.code(401).send({ error: 'unauthorized' });
  }
  done();
}

app.get('/health', async () => ({ ok: true, browser: browser.status() }));
app.register(async (api) => {
  api.addHook('onRequest', apiAuth);
  api.get('/status', async () => ({
    browser: browser.status(),
    loginUrl: `https://${config.publicHost}/login/vnc.html?autoconnect=1&resize=remote&path=login/websockify`,
  }));
  api.post('/browser/open-login', async () => browser.openLogin());
  api.post('/browser/navigate', async (request, reply) => {
    try { return await browser.navigate(request.body?.url); }
    catch (error) { return reply.code(400).send({ error: error.message }); }
  });
  api.get('/page/snapshot', async (request) => browser.snapshot(request.query));
  api.post('/page/screenshot', async (request) => {
    const result = await browser.screenshot(request.body ?? {});
    return { ...result, downloadUrl: `https://${config.publicHost}/api/captures/${result.name}` };
  });
  api.get('/captures/:name', async (request, reply) => {
    try {
      const data = await fs.readFile(browser.capturePath(request.params.name));
      return reply.type('image/png').send(data);
    } catch { return reply.code(404).send({ error: 'not_found' }); }
  });
}, { prefix: '/api' });

app.register(async (login) => {
  login.addHook('onRequest', novncAuth);
  login.register(fastifyHttpProxy, { upstream: 'http://127.0.0.1:6080', websocket: true, prefix: '/' });
}, { prefix: '/login' });

async function shutdown() {
  await browser.stop().catch(() => {});
  await app.close().catch(() => {});
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await browser.start();
await app.listen({ host: '0.0.0.0', port: config.port });
