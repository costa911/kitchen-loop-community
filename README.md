<p align="center">
  <img src="public/thekitchenloop.png" alt="The Kitchen Loop logo" width="160" />
</p>

# The Kitchen Loop Community Edition

The Kitchen Loop is a simple recipe book, meal planner and shopping-list app for one household.

It helps you:

- keep recipes in one searchable place;
- make a fortnightly meal plan without starting from a blank page; and
- turn that plan into a practical shopping list.

It is free, self-hosted and does not require an account. “Self-hosted” just means the app runs on your own computer and keeps its data in a local file.

## Why people use it

- Your recipes, plans, cooking history and shopping lists stay on your computer.
- It works without a subscription or login.
- The app works offline; only links to the original social posts need an internet connection.
- You can add, edit and delete recipes, and keep your own backups.
- It starts with 18 recipes: 15 Kitchen Loop originals and 3 sample recipes with written methods.

## Install

Most people should use Docker Desktop or Docker Engine. You do not need to install Node.js for that route.

1. Install [Git](https://git-scm.com/downloads).
2. Follow the guide for your computer:
   - [Windows installation](docs/install-windows.md)
   - [macOS installation](docs/install-macos.md)
   - [Linux installation](docs/install-linux.md)
3. Open [http://localhost:8080](http://localhost:8080) after the app starts.

If you are comfortable with Node.js, the platform guides also explain the direct, no-container option. Node.js 22 or newer is required.

## Your first launch

The first launch creates the app's local data file and loads the sample recipes. Nothing is uploaded by the app unless you explicitly enable one or more optional anonymous insight permissions in Privacy.

The app is intended for one computer and one household data folder. Do not run two copies against the same data folder: the app will refuse the second copy to prevent one copy overwriting the other.

## The three main parts

### Recipes

Search recipes, browse by category, add your own recipes, edit them, delete them and record when you cook them. Kitchen Loop originals link to their original social posts; the three sample recipes include written methods.

### Fortnightly meal planning

Create a two-week plan with different dinners, a lunch rotation, dessert and suggested sides. You can adjust the plan and mark meals as cooked.

### Shopping lists

Build a shopping list from the plan or from a hand-picked recipe list. Items are grouped into a big shop, fresh top-ups and staples to check. You can tick items, print the list or copy/share it.

## Backups and restore

Please make a backup before upgrading or moving the app. A backup contains your recipes, plans, cooking history and shopping ticks.

Read [Backup and restore](docs/backup-and-restore.md) for the Docker, Podman and Node.js commands. Restore replaces the current data, so stop the app first and keep a separate copy of the backup.

## Recipes from The Kitchen Loop

A new installation includes 15 recipes published by The Kitchen Loop and marked as originals. Their cooking methods remain in the original social posts, so those links need an internet connection. The three invented sample recipes have full written methods and no social posts.

## Privacy and optional anonymous insights

The app is local by default. The Privacy page keeps adoption, product usage and approximate country permissions separate, and all are off until you choose them.

If you opt in:

- adoption reports one install and at most one heartbeat per month;
- product usage counts only successful recipe creations, edits and activated social/cooking-method links; and
- approximate country reporting uses one country-level signal from the separately operated telemetry service.

Telemetry payloads do not contain recipe contents, household information or browsing history. They also exclude recipe identifiers, ingredients, names, URLs, plans, shopping lists, identities, GPS data, coordinates, cities and file paths. Cloudflare processes the network request to deliver the separately operated service, but IP addresses are not stored in our telemetry database. The telemetry backend and its private dashboard are maintained separately from this Community Edition repository.

See [Security and privacy](docs/security-and-privacy.md) for the full explanation.

## Need help?

- To report a bug, open a [GitHub issue](https://github.com/costa911/kitchen-loop-community/issues) and include what you expected, what happened and which operating system and installation method you used. Do not attach your household data file.
- To suggest an improvement, open an issue with the problem it would solve and, if possible, a small example of the desired behaviour.
- For recovery and backup problems, read [Backup and restore](docs/backup-and-restore.md) before changing or deleting files.

## For contributors

The application uses Node.js built-in modules and has no runtime npm dependencies. See [Development](docs/development.md) for local development, tests and the optional browser test. [TESTING.md](TESTING.md) records what has been verified and what still needs platform-specific testing.

## Licence and attribution

MIT — see [LICENSE](LICENSE). The frontend is adapted from the original The Kitchen Loop by Costa (MIT). The bundled DM Sans font is under the SIL Open Font License 1.1 (`public/fonts/OFL.txt`).
