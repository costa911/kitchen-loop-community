# Backup and restore

Make a backup before upgrading, moving the app or changing its installation method. The backup contains recipes, plans, cooking history and shopping ticks.

Keep backup files somewhere separate from the app's data folder. Do not share them publicly: they contain your household data.

## Docker or Podman

Create a backup while the app is running:

```bash
docker compose exec -T kitchen-loop node server.js backup > kitchen-loop-backup.json
```

Restore a backup:

```bash
docker compose stop
docker compose run --rm -T kitchen-loop node server.js restore < kitchen-loop-backup.json
docker compose start
```

For Podman, replace `docker compose` with `podman compose` or `podman-compose`.

## Node.js

Create a backup while the app is running:

```bash
node server.js backup > kitchen-loop-backup.json
```

Stop the app first, then restore:

```bash
node server.js restore < kitchen-loop-backup.json
node server.js
```

## Safety behaviour

- Restore validates the whole backup before changing anything.
- Restore refuses to run while the app is using the same data folder.
- A successful save keeps the previous valid file as `data/kitchen-loop.json.bak`.
- A damaged data file is kept aside instead of replacing the last good backup.
- If the main data file is missing while a backup exists, the app refuses to start rather than silently creating a new household.

If the app will not start because the data file is damaged, stop it and restore the automatic backup:

```bash
# Docker or Podman
docker compose stop
docker compose run --rm -T kitchen-loop sh -c 'node server.js restore < /data/kitchen-loop.json.bak'
docker compose start

# Node.js
node server.js restore < data/kitchen-loop.json.bak
```
