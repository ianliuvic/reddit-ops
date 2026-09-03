# reddit-ops

Private browser operations service for Reddit. It starts official Google Chrome as a desktop process through an optional authenticated upstream proxy, connects Playwright over Chrome DevTools Protocol, exposes a password-protected noVNC session for manual authentication, and provides authenticated APIs for navigation, DOM snapshots, and screenshots. The browser profile is persistent across deployments.

The service supports read-only browser inspection and explicitly approved joins of public or restricted subreddits. Private communities remain blocked. Joining requires an exact `JOIN r/<name>` approval value and is verified after the request. It does not automate CAPTCHA solving, anti-detection, posting, comments, votes, or direct messages.

Required environment variables: `ADMIN_API_KEY`, `NOVNC_USERNAME`, and `NOVNC_PASSWORD`. Persist `/app/storage` across deployments.
