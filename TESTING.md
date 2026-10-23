# Testing and release evidence — v0.1.0

This file records what has **actually been run and passed**, and what has **not been tested**. Update it whenever a runtime or platform is verified.

## Test suites in this repository

| Suite | Command | Needs |
|---|---|---|
| Unit, API, locking, binding, recovery, origin-marker, first-run content, frontend telemetry-client and release-hygiene tests | `npm test` | Node.js 22+ |
| Container smoke test (19 checks; 2 are skipped automatically, and reported as skipped, when the `ss` tool or a LAN address is unavailable) | `COMPOSE="docker compose" scripts/smoke-compose.sh` | A compose tool, `curl`, Node.js |
| Browser end-to-end test (13 steps) | `CHROMIUM_PATH=… node scripts/e2e-browser.mjs [url]` | `npm install --no-save playwright-core` and a Chromium binary |

**`npm test`** covers:
- first start;
- persistence and restart;
- serialised and conflicting writes (409);
- atomic writes and `.bak`;
- refusing corrupt, invalid or newer-version data files;
- backup and restore, including recovery: restoring over a corrupt data file keeps the last good `.bak` byte-for-byte and keeps the damaged file aside; invalid input changes nothing on disk; a simulated disk failure during restore leaves the live file and `.bak` untouched and no temp files; restored data is intact after restart; a damaged file is never rotated into `.bak`; a missing data file next to a backup is not re-initialised with sample recipes;
- one-process-per-data-directory locking: a real second `node server.js` process refused; the regression for an owner paused for 16 s between its ownership check and its write (another process cannot take over or write, and the owner's write lands intact); a frozen (`SIGSTOP`) owner keeping the lock; immediate recovery after `SIGKILL`; data directories longer than the Unix socket path limit;
- request validation and XSS-shaped input;
- Host-header and cross-site write protection;
- first-run content: exactly the 15 published recipes carry the marker; each has an https TikTok (`@the_kitchen_loop`), Instagram and Threads link with no tracking parameters; no cooking-method text is stored for them; the invented samples have written methods; 14 different mains; an existing installation is never re-seeded;
- the “Kitchen Loop Original” marker: kept when an official recipe is edited and when an authentic backup is restored; never acquired by user-created recipes (through hand-made API requests, re-using a deleted official id, a forged backup or a hand-edited data file); unknown values rejected; and the accepted limitation pinned by a test: a hand-edited data file or backup that puts arbitrary content under a genuine canonical id keeps the badge (the badge is protected during normal app use, not tamper-proof against someone who edits local files);
- the loopback-only listener;
- the tracked-file allowlist and forbidden-reference scan.
- frontend telemetry consent migration, enable-all/disable-all/customisation, successful-save event ordering, social-link click delegation and platform mapping.

**The container smoke test** covers:
- build and first start with the 18 first-run recipes;
- the non-root user;
- the port bound to loopback only and not reachable from the LAN address;
- 421 for requests addressed to other hostnames;
- a second server container on the same volume refusing to start, including while the app container is paused;
- immediate restart with all data after the app container is killed with `SIGKILL`;
- persistence across `restart` and across `down` + `up`;
- backup;
- restore refused while the app runs, and damaged backups refused;
- restore;
- refusing a damaged data file at startup, and recovery from `.bak`.

**The browser test** covers:
- the first-run collection (15 originals with the icon, 3 invented samples);
- an original's “View cooking method on TikTok” button (new tab, `noopener`, internet note) and its three platform buttons; an invented sample's written method with no social buttons;
- the first-run welcome popup, search, add, edit (an edited original keeps its icon), delete and cook logging;
- hostile HTML in recipe text shown literally, and `javascript:` links rejected;
- a plan of 14 different dinners, the shopping list and ticks;
- archiving the custom list;
- persistence after a restart;
- the two-tab stale-save conflict;
- no console errors and no requests to any origin other than the app.

## Results

Environment: Fedora Linux 44 Workstation, kernel 7.2.11, x86_64. Date: 2026-10-23.

| Runtime / browser | Version | Result |
|---|---|---|
| Node.js (`npm test`, 83 tests) | 22.23.1 | **Passed** in the clean public staging directory |
| Node.js on macOS (Apple Silicon) | 23.7.0 | **Pending re-test.** At `f4170a3` one test failed with an unhandled `write EPIPE` in the test harness (not the app): a refused `restore` exits without reading its stdin, and the 12 KB backup exceeds macOS's 8 KiB inter-process buffer. Fixed in the harness; a 1 MiB regression test reproduces the original failure on Linux too. |
| Headless Chromium, origin icon (one-off check with two placeholder official recipes) | Chrome for Testing 149 | **Passed** on desktop (1100 px) and mobile (390 px, 3×): icon only on marked cards, 22×22 px, alt and tooltip present; pop-up label; marker kept after editing and reload; none on a newly added recipe |
| Node.js, fresh clone, `node server.js` | 22.23.1 | **Passed**: starts, creates `./data`, listens on `127.0.0.1:8080` only |
| Rootless Podman + podman-compose (smoke test, 19 checks) | Podman 5.8.9, podman-compose 1.6.0 | **Passed** |
| Rootless Podman + podman-compose, fresh clone, documented `up -d` on port 8080 | as above | **Passed**, then the browser test passed against it and data survived `restart` |
| Headless Chromium (browser test vs. Node server, with server restart) | Chrome for Testing 149.0.7827.55, playwright-core 1.56 | **Passed**, 13/13 |
| Headless Chromium (browser test vs. fresh Podman install) | as above | **Passed**, 11/11 (the restart step runs separately) |
| Public-tree path/reference scan and staged release-hygiene tests | current staging | **Passed**; no backend paths or private backend references found |

## Social link validation (2026-10-22)

The 45 links (15 recipes × TikTok, Instagram, Threads) were supplied by the author and match the author's own production records for the same recipes.

| Platform | What was verified | Result |
|---|---|---|
| TikTok (15) | Each short share link was followed to its permanent URL; stored without share-tracking parameters | **All 15 resolve** to distinct public posts on `@the_kitchen_loop`. The 14 that already existed in production resolve to the same posts as the production links. Captions could not be read without signing in, so the post content was not machine-checked against recipe names. |
| Instagram (15) | Format only (`/p/<code>/`, trailing slash, no tracking) | **Not verifiable without signing in**: Instagram answers identically for real and non-existent posts. |
| Threads (15) | Format only (`/share/<code>/`) | **Not verifiable without signing in**, and share links cannot be resolved to permanent post URLs anonymously. Kept as supplied. |

## Not yet tested

These are **not verified**. Do not claim support for them until they pass:

- **Docker Engine / Docker Desktop with `docker compose`** — the primary documented install method. Run the container smoke test and the browser test with `COMPOSE="docker compose"`.
- The `podman compose` wrapper (only standalone `podman-compose` was used).
- macOS, Windows (Docker Desktop / WSL2), and arm64 hosts. The image is pinned to a multi-architecture digest, but has only run on x86_64.
- Firefox, Safari and mobile browsers. Only headless Chromium was automated.
- A completely cold first build. The `node:22.23.4-alpine` base image was already cached locally.
- Data directories on network filesystems (not supported; the lock is designed for local disks and volumes).
- Plain Node.js on Windows (not supported: the lock uses a Unix socket; use Docker Desktop or WSL2).
