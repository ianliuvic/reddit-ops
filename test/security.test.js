import test from 'node:test';
import assert from 'node:assert/strict';
import { isAllowedNavigationUrl, normalizeSubredditName, safeEqual } from '../src/security.js';

test('only Reddit and Google auth destinations are allowed', () => {
  assert.equal(isAllowedNavigationUrl('https://www.reddit.com/r/swimwear/'), true);
  assert.equal(isAllowedNavigationUrl('https://accounts.google.com/o/oauth2/auth'), true);
  assert.equal(isAllowedNavigationUrl('https://reddit.com.evil.example/'), false);
  assert.equal(isAllowedNavigationUrl('http://www.reddit.com/'), false);
  assert.equal(isAllowedNavigationUrl('file:///etc/passwd'), false);
});

test('safeEqual handles unequal strings', () => {
  assert.equal(safeEqual('alpha', 'alpha'), true);
  assert.equal(safeEqual('alpha', 'beta'), false);
  assert.equal(safeEqual('', 'x'), false);
});

test('normalizes subreddit names', () => {
  assert.equal(normalizeSubredditName('r/printondemand'), 'printondemand');
  assert.equal(normalizeSubredditName(' ClothingStartups '), 'ClothingStartups');
});

test('rejects unsafe subreddit names', () => {
  for (const value of ['', 'r/a', '../api', 'name?x=1', 'x'.repeat(22)]) {
    assert.throws(() => normalizeSubredditName(value), /Invalid subreddit name/);
  }
});
