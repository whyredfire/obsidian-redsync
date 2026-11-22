# Red Sync

Red Sync synchronises Obsidian vaults between your own devices through a small server you host, with Cloudflare R2 as the long-term backup. A change appears on your other devices within a second or two, even in a note open on both. Several people (a family) can share one server; each has their own vaults, optionally end-to-end encrypted so the server's owner cannot read them.

- **Plug-in** (`plugin/`): TypeScript, Obsidian 1.13 or later, desktop and mobile.
- **Server** (`server/`): Rust; SQLite, a cache on disk, and R2.
- **Test bench** (`testbench/`): two real Obsidian devices in containers, driven by scripts.

## Running the server

On a machine with Docker, an HTTPS reverse proxy, and an R2 bucket with an API token limited to that bucket:

```sh
git clone git@github.com:whyredfire/obsidian-redsync.git && cd obsidian-redsync/deploy
cp .env.example .env    # the R2 details
docker compose up -d --build
```

The server listens on 127.0.0.1:8080. Point your reverse proxy at it with HTTPS, and let it pass WebSocket upgrades (devices keep one open at `/v1/ws`). Litestream copies database changes to R2 every 10 seconds, and restores it on start when the disk is new.

Add people and give each their invite code:

```sh
docker compose exec server redsync-server user add mum --quota 10GB
docker compose exec server redsync-server help    # every command
```

## Setting up devices

1. Install the plug-in with [BRAT](https://github.com/TfTHacker/obsidian42-brat): 'Add a beta plugin' with `whyredfire/obsidian-redsync`.
2. On the first device: Settings, Red Sync, 'Set up sync', 'Start a new vault'. Enter the server address and the invite code, and a passphrase for end-to-end encryption.
3. On each further device: on a device already set up, select 'Add a device' and scan the QR code with the new device's camera (or paste the link into 'Join a vault'). Enter the same passphrase.

Nothing else to configure: Red Sync uploads as you type, merges edits made on two devices at once, and keeps a conflicted copy when a merge is impossible.

## Backups and recovery

R2 holds every version of every file, a snapshot of each vault every 6 hours, and (through Litestream) the server's database.

| Lost | Recovery |
| --- | --- |
| The VPS | A new VPS with the same `.env`; `docker compose up -d` restores the database from R2. |
| The database and its R2 copy | `redsync-server restore` rebuilds it from the newest snapshots; devices upload anything newer. |
| The server for good | `REDSYNC_STORE=s3://bucket REDSYNC_PASSPHRASE=… redsync-server export <vault-id> <folder>` writes a vault as plain files (with the `AWS_*` variables for R2). |

## Development

```sh
cd plugin && bun install && bun run build && bun run test
cd server && cargo test
cd testbench && docker compose up -d --build && bun install
bun run smoke              # both devices load the plug-in
bun run sync               # synchronisation checks (bun run sync:encrypted: set up through the dialogues, encrypted)
bun run fuzz -- --seed 7   # random use of both devices with network loss (--safe: also checks no line is lost)
bun run drill              # the server loses its database and is restored from a snapshot
```

Watch the test devices at https://localhost:3001 and https://localhost:3002.

Releases: run the 'release' workflow with a version such as `2.0.0`.
