# Red Sync

[![Release](https://img.shields.io/github/v/release/whyredfire/obsidian-redsync)](https://github.com/whyredfire/obsidian-redsync/releases/latest)
[![Licence: MIT](https://img.shields.io/github/license/whyredfire/obsidian-redsync)](LICENSE)

Synchronise your Obsidian vaults between your own devices, through a small server you host yourself.

Red Sync is a self-hosted alternative to a sync subscription. Changes appear on your other devices within a second or two, even in a note open on both. A family can share one server, with each person's vaults kept apart and, if they like, end-to-end encrypted so that not even the server's owner can read them.

## Features

- **Live sync**: uploads as you type; edits from other devices arrive in open notes, and your cursor stays with your text.
- **Merges instead of conflicts**: edits to the same note on two devices are combined. When they cannot be, the other version is kept as a conflicted copy, never thrown away.
- **End-to-end encryption**: optional, chosen per vault. File contents, names, and metadata are encrypted on the device.
- **File history**: look at or restore any version of a file from the last 30 days.
- **Easy setup for new devices**: scan a QR code; the new device joins with the passphrase, nothing to type.
- **Desktop and mobile**: Windows, macOS, Linux, iOS, and Android.
- **Safe by default**: a vault folder that suddenly looks empty is not passed on as hundreds of deletions; files too large for the server stay on the device instead of blocking the rest.
- **Your own storage**: Cloudflare R2 keeps every file and a snapshot of each vault, so a lost server is restored from it, or a vault exported as plain files without any server at all.

## Requirements

- Obsidian 1.13 or later.
- A Red Sync server: your own (see [Hosting the server](#hosting-the-server)), or a family member's with an invite code from them.

## Installation

Install [Red Sync](https://community.obsidian.md/plugins/red-sync) from Obsidian's community plugins: **Settings → Community plugins → Browse**, search for 'Red Sync', then **Install** and **Enable**.

## Getting started

1. **On your first device**: **Settings → Red Sync → Set up sync → Start a new vault**. Enter the server address and your invite code. Leave end-to-end encryption on and choose a passphrase; nobody can recover your notes without it.
2. **On each further device**: on a device already set up, select **Add a device** and scan the QR code with the new device's camera, or open the link on it. The new device joins and downloads the vault on its own; the passphrase travels inside the link, encrypted. The link works once, within 15 minutes.

That is all. The status bar shows 'Synchronised', 'Synchronising', or 'Offline' with how many changes are waiting.

## Usage

- **History**: run **Show this file's history** from the command palette, or select **Red Sync history** in a file's menu. Each version shows when it was saved and on which device; **Show** opens it, **Restore** puts it back (as a new version, so nothing is lost).
- **Conflicted copies**: when two devices changed the same lines, the newer version stays and the other is saved next to it as 'Note (Conflicted copy 202611241430).md'.
- **Devices**: **Settings → Red Sync** lists your devices and when each was last seen. Disconnect a lost phone there; it stops at once.
- **Pause sync** and **Silence notifications** are per device.

### Limits

- Files up to 100 MB by default (the server's owner can change this). Larger files stay on the device they are on, with one notice.
- Storage per person is set by the server's owner (10 GB by default) and includes 30 days of history. **Settings → Red Sync** shows how much is used.
- Obsidian's settings folder (`.obsidian`) is not synchronised.

## Troubleshooting

- **Something did not arrive**: **Settings → Red Sync → Check everything again** compares every file with the server and fixes any difference.
- **'Update Red Sync on this device and the server'**: the device and the server run releases that cannot talk to each other. Update both.
- **'Storage on the server is full'**: ask the server's owner for more; your changes stay on the device until then.
- **Asking for help**: turn on **Detailed log**, reproduce the problem, then **Copy debug report** and attach it to an issue. The report holds no passphrase or token.

## FAQ

**Is there a hosted service?** No. You run the server, or use one run by someone you trust.

**Can I turn on encryption later?** No: it is chosen when a vault is created. To encrypt an existing vault, disconnect every device, then select 'Start a new vault' on one of them with a new invite code.

**What if I forget the passphrase?** Any device already set up still works and passes it on through **Add a device**. If every device is lost, encrypted notes cannot be recovered; that is the point of the encryption.

**Does it work alongside Obsidian Sync or another sync tool?** Use one sync tool per vault; two would fight over the same files.

## Hosting the server

On a machine with Docker, an HTTPS reverse proxy, and an R2 bucket with an API token limited to that bucket:

```sh
git clone https://github.com/whyredfire/obsidian-redsync.git && cd obsidian-redsync/deploy
cp .env.example .env    # the R2 details
docker compose up -d    # pulls ghcr.io/whyredfire/obsidian-redsync
```

The server listens on 127.0.0.1:8080. Point your reverse proxy at it with HTTPS, and let it pass WebSocket upgrades (devices keep one open at `/v1/ws`). Litestream copies database changes to R2 every 10 seconds, and restores it on start when the disk is new.

Add people and give each their invite code:

```sh
docker compose exec server redsync-server user add mum --quota 10GB
docker compose exec server redsync-server help    # every command
```

### On Kubernetes

The chart in `chart/` runs the server with Litestream as a sidecar, on one pod with a volume (SQLite allows a single writer, so it never runs two):

```sh
kubectl create secret generic red-sync-r2 --from-literal=AWS_ACCESS_KEY_ID=… --from-literal=AWS_SECRET_ACCESS_KEY=…
helm install red-sync ./chart --set r2.endpoint=https://<account-id>.r2.cloudflarestorage.com,r2.bucket=redsync,r2.existingSecret=red-sync-r2
kubectl exec deploy/red-sync -c server -- redsync-server user add mum
```

Route HTTPS to the `red-sync` Service on port 8080 with your own Ingress, or set `httpRoute.enabled` for a Gateway API route. See `chart/values.yaml` for everything else.

## Backups and recovery

R2 holds every file, its versions from the last 30 days, a snapshot of each vault every 6 hours (kept for 30 days), and (through Litestream) the server's database.

| Lost | Recovery |
| --- | --- |
| The VPS | A new VPS with the same `.env`; `docker compose up -d` restores the database from R2. |
| The database and its R2 copy | `redsync-server restore` rebuilds it from the newest snapshots; devices upload anything newer. |
| The server for good | `REDSYNC_STORE=s3://bucket REDSYNC_PASSPHRASE=… redsync-server export <vault-id> <folder>` writes a vault as plain files (with the `AWS_*` variables for R2). |

## Disclosures

- **Account**: Red Sync needs a Red Sync server, which you host yourself (see [Hosting the server](#hosting-the-server)), and an invite code from that server's owner. There is no hosted service and nothing to pay for.
- **Network use**: the plug-in connects only to the server address you enter, over HTTPS and a WebSocket, to upload and download the vault's files and their history. With end-to-end encryption on, file contents and names are encrypted on the device before they are sent; with it off, the server's owner can read them.
- **Vault access**: to synchronise the vault, the plug-in lists and reads every file in it (the `.obsidian` folder excepted) and writes the changes that come from your other devices.
- **Clipboard**: the plug-in only writes to the clipboard, when you select a copy button (the setup link, the log, or the debug report). It never reads it.
- **Data on the device**: the server's access token and the passphrase are kept in Obsidian's secret storage on each device.
- No telemetry, no advertising, and no access to files outside the vault.

## Development

The repository holds the plug-in (`plugin/`, TypeScript), the server (`server/`, Rust with SQLite), and a test bench (`testbench/`: two real Obsidian devices in containers, driven by scripts).

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

Releases: run the 'release' workflow with a version such as `2.0.0`. It publishes the plug-in as a GitHub release and the server image to `ghcr.io/whyredfire/obsidian-redsync` (`2.0.0` and `latest`, for amd64 and arm64). The image is built before the plug-in is released, so a failed build stops the release.

## Licence

MIT; see [LICENSE](LICENSE).
