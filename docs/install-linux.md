
# Install on Linux

The Kitchen Loop can be installed on Linux using Node.js, Docker Compose or Podman.

If you're new to the project, we recommend **Option 1: Quick Start**, which follows our simple three-command installation video.

## Option 1: Quick Start — Linux (Recommended)

This method runs The Kitchen Loop directly on your computer using Node.js.

Our installation video demonstrates Fedora Linux, but the process is similar on Ubuntu, Debian and Linux Mint.

### Step 1: Install the dependencies

**Fedora Linux:**

```bash
sudo dnf install -y git nodejs npm
```

**Ubuntu, Debian or Linux Mint:**

```bash
sudo apt update && sudo apt install -y git nodejs npm
```

If you already have Git, Node.js and npm installed, you can skip this step.

**Important:** The Kitchen Loop requires Node.js 22 or newer.

Check your version:

```bash
node --version
```

If your distribution provides an older version, install a supported release from [nodejs.org](https://nodejs.org/en/download/).

### Step 2: Download The Kitchen Loop

Clone the public GitHub repository and enter the project folder:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git && cd kitchen-loop-community
```

### Step 3: Install and launch

```bash
npm install && npm start
```

Once the server starts, open:

**http://localhost:8080**

That's it! Your Kitchen Loop is running locally.

The app has no external runtime npm dependencies, so `npm install` is optional. The `npm start` command starts the application using `node server.js`.

**To stop the application:** Press `Ctrl+C` in the terminal.

**To launch it again later:**

Open a terminal, navigate to your `kitchen-loop-community` directory and run:

```bash
npm start
```


### 🎬 Video Installation Guide

Watch our 30-second Fedora Linux installation walkthrough.

The video demonstrates Option 1 (Quick Start), including installing dependencies, cloning the repository and launching The Kitchen Loop.

**Watch on your preferred platform:**

- 💼 [LinkedIn — Installation Video](https://lnkd.in/p/dvX5jY_h)
- 📸 [Instagram — Installation Reel](https://www.instagram.com/reel/De_VGXBg2On/)
- 🎵 [TikTok — Installation Video](https://www.tiktok.com/@the_kitchen_loop/video/7701248856448650518)
- 🧵 [Threads — Installation Video](https://www.threads.com/share/D4OVTuq3N/)

**Using Ubuntu, Debian or Linux Mint?**

The video demonstrates Fedora's `dnf` package manager. Use `apt` instead when installing dependencies in Step 1. Steps 2 and 3 remain the same, provided you have Node.js 22 or newer.


---

## Option 2: Docker Compose

Docker keeps the application and its dependencies inside a container.

Install Docker Engine with the Compose plugin and [Git](https://git-scm.com/downloads), then run:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
docker compose up -d
```

Open [http://localhost:8080](http://localhost:8080).

---

## Option 3: Podman

With rootless Podman and either `podman compose` or `podman-compose`:

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
podman compose up -d
```

If your system uses the separate command, replace `podman compose` with `podman-compose`.

Open [http://localhost:8080](http://localhost:8080).

---

## Option 4: Node.js (Manual Installation)

If you already have [Node.js 22 or newer](https://nodejs.org/en/download/) and Git installed, you can start the application directly.

```bash
git clone https://github.com/costa911/kitchen-loop-community.git
cd kitchen-loop-community
node server.js
```

Open [http://localhost:8080](http://localhost:8080).

Stop the app with `Ctrl+C`.

---

## Data storage and important notes

The application stores your household data locally in:

`data/kitchen-loop.json`

The lock is designed for local disks and Docker/Podman volumes, not network filesystems.

**Do not run two copies of The Kitchen Loop against the same data folder.**

Your recipes, meal plans and shopping lists remain on your computer. Optional anonymous telemetry is disabled by default and can be managed in the application's Privacy settings.

For backups and recovery, read [Backup and restore](backup-and-restore.md).

## Feedback and support

The Kitchen Loop Community Edition is an open-source community project.

If you experience installation problems, discover bugs or have suggestions for improvements, please open a [GitHub issue](https://github.com/costa911/kitchen-loop-community/issues).

Your feedback helps improve the project for everyone!
