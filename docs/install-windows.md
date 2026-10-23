# Install on Windows

The recommended Windows setup is Docker Desktop. It runs the app in a small local container and keeps household data in a Docker-managed volume.

## What you need

- Windows 10 or 11;
- [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/); and
- [Git](https://git-scm.com/downloads).

Docker Desktop includes Docker Compose, the tool that starts the app and its storage together.

## Start the app

Open PowerShell or Command Prompt and run:

```powershell
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

The first start builds the app image and creates the sample recipes. This may take about a minute.

## Start and stop later

```powershell
docker compose stop
docker compose start
```

Your data remains in the Docker volume when you stop the app or run `docker compose down`. Do not use `docker compose down -v` unless you intend to delete the volume and all data in it.

To use another port, for example 9090:

```powershell
$env:KITCHEN_LOOP_PORT=9090
docker compose up -d
```

Then open [http://localhost:9090](http://localhost:9090).

## Windows alternatives and limitations

The direct Node.js setup is not supported in ordinary Windows PowerShell because the app's single-folder lock uses a Unix socket. Use Docker Desktop, or use Node.js inside WSL2. See the [Linux guide](install-linux.md) for the WSL2 route.

For backups and recovery, read [Backup and restore](backup-and-restore.md).
