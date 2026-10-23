# Security and privacy

## Local by default

Kitchen Loop listens on this computer and accepts requests addressed to `localhost`. It is not a hosted service and has no login. Anyone who can use your computer account can use the local app, so do not expose its port to the network or internet.

The app stores household data in one local JSON file. The bundled container runs as an unprivileged user, uses a read-only application filesystem and publishes its port on the host loopback interface.

## Your data

Recipes, meal plans, cooking history and shopping lists stay on the computer unless you choose to copy or share a backup yourself. Social links open outside the app and need an internet connection; the rest of the app works offline.

## Optional anonymous insights

The Privacy page keeps three choices independent:

- **Adoption:** one install event and at most one heartbeat per month.
- **Product usage:** counts successful recipe creations, successful edits and activated recipe social/cooking-method links.
- **Approximate country:** one country-level signal from the separately operated telemetry service after renewed consent.

All three are off by default. Enabling one does not enable another. You can withdraw all or individual permissions from Privacy.

The client does not send recipe content, recipe identifiers, ingredients, names, URLs, plans, shopping lists, identities, IP addresses, GPS data, coordinates, cities, file paths or browsing history. The telemetry backend and private dashboard are not included in this public repository.

## Safe use

- Keep the app bound to localhost.
- Keep backup files private.
- Do not run two copies against the same data folder.
- Do not delete lock or backup files while the app is running.
- Keep Docker, Podman, Node.js and your operating system updated.
