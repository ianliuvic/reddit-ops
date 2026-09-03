# reddit-ops

Private browser operations service for Reddit. It starts official Google Chrome as a normal desktop process, connects Playwright over the Chrome DevTools Protocol, exposes a password-protected noVNC session for manual authentication, and provides authenticated APIs for navigation, DOM snapshots, and screenshots. The Chrome profile is persistent across deployments.

The service intentionally does not automate CAPTCHA solving, anti-detection, posting, comments, votes, or direct messages in its initial release.

Required environment variables: `ADMIN_API_KEY`, `NOVNC_USERNAME`, and `NOVNC_PASSWORD`. Persist `/app/storage` across deployments.
