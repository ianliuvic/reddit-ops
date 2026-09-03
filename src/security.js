import crypto from 'node:crypto';

export function safeEqual(left, right) {
  const a = Buffer.from(String(left ?? ''));
  const b = Buffer.from(String(right ?? ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function isAllowedNavigationUrl(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return host === 'reddit.com' || host.endsWith('.reddit.com')
    || host === 'google.com' || host.endsWith('.google.com')
    || host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com')
    || host === 'gstatic.com' || host.endsWith('.gstatic.com');
}

export function normalizeSubredditName(value) {
  const name = String(value ?? '').trim().replace(/^r\//i, '');
  if (!/^[A-Za-z0-9_]{2,21}$/.test(name)) {
    throw new Error('Invalid subreddit name');
  }
  return name;
}
