# Development

## Requirements

Node.js 22 or newer is required. The application uses Node.js built-in modules, so there are no runtime dependencies to install.

## Run locally

```bash
node server.js
```

Open [http://localhost:8080](http://localhost:8080). The default data folder is `./data`; `PORT` and `DATA_DIR` can be set when needed.

## Run tests

```bash
npm test
```

The test suite covers storage, backup and restore, validation, locking, request security, first-run recipes, public release hygiene and the frontend telemetry client.

The container smoke test needs a compose tool:

```bash
COMPOSE="docker compose" scripts/smoke-compose.sh
```

The optional browser test needs Playwright and a Chromium binary:

```bash
npm install --no-save playwright-core
CHROMIUM_PATH=/path/to/chrome node scripts/e2e-browser.mjs
```

See [TESTING.md](../TESTING.md) for verified environments and known platform limitations.

## Project layout

- `server.js` — local server and backup/restore commands
- `lib/` — HTTP handling, storage, locking and validation
- `public/` — the single-page application
- `seed/` — first-run sample recipes
- `test/` — application and client-side telemetry tests
- `scripts/` — smoke and browser test helpers

The telemetry backend is operated separately and is not part of this repository.
