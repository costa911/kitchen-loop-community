# Install on Linux

You can use Docker, Podman or Node.js. Docker or Podman keeps the setup self-contained; Node.js is useful if you prefer to run the app directly.

## Option 1: Docker Compose

Install Docker Engine with the Compose plugin and [Git](https://git-scm.com/downloads), then run:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

## Option 2: Podman

With rootless Podman and either `podman compose` or `podman-compose`:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
podman compose up -d
```

If your system uses the separate command, replace `podman compose` with `podman-compose`.

## Option 3: Node.js

Install [Node.js 22 or newer](https://nodejs.org/en/download/) and Git, then run:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
node server.js
```

Open [http://localhost:8080](http://localhost:8080). Stop the app with `Ctrl+C`.

The app stores data in `data/kitchen-loop.json`. The lock is designed for local disks and Docker/Podman volumes, not network filesystems. Do not run two copies against the same data folder.

For backups and recovery, read [Backup and restore](backup-and-restore.md).
