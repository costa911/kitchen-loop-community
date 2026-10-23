# Install on macOS

You can run Kitchen Loop with Docker Desktop or directly with Node.js. Docker is the easiest choice if you are new to local servers.

## Option 1: Docker Desktop

Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/) and [Git](https://git-scm.com/downloads), then run:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

Stop and restart the app with:

```bash
docker compose stop
docker compose start
```

The Docker volume keeps your data. `docker compose down -v` deletes that volume, so use it only when you intentionally want to remove the data.

## Option 2: Node.js

Install [Node.js 22 or newer](https://nodejs.org/en/download/) and Git. Then run:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
node server.js
```

Open [http://localhost:8080](http://localhost:8080). Stop the app with `Ctrl+C`.

The app stores data in `data/kitchen-loop.json`. Do not run two copies against the same data folder.

For backups and recovery, read [Backup and restore](backup-and-restore.md).
