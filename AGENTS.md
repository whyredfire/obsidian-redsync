# Red Sync: notes for coding assistants

Red Sync synchronises Obsidian vaults between a person's own devices through a self-hosted server, with Cloudflare R2 as the long-term backup. Several people (a family) can share one server; each owns their own vaults. The design is in `docs/design.md` (kept out of git).

## Layout

- `plugin/`: the Obsidian plug-in (TypeScript, Bun, esbuild). Plug-in ID `red-sync`; needs Obsidian 1.13.0 or later. `manifest.json` and `versions.json` are at the repository root, where Obsidian reads them; the plug-in is in Obsidian's community directory (https://community.obsidian.md/plugins/red-sync).
    - `engine.ts`: synchronisation. `merge.ts`: three-way merge (lines first, then characters). `crypto.ts`: end-to-end encryption, mirrored by `server/src/export.rs` (the fixture in `server/tests/fixtures/` comes from `plugin/scripts/fixture.ts`).
- `server/`: the sync server (Rust, axum, SQLite). `src/protocol.rs` defines every message; `cargo test` regenerates their TypeScript types in `plugin/src/protocol/` (commit them, never edit them by hand).
- `testbench/`: docker compose with two Obsidian containers (devices A and B) and the server, plus scripts that drive the devices over the Chrome DevTools Protocol. Device B's vault is on a case-insensitive file system; its network to the server can be cut.
- `chart/`: the Helm chart (server with a Litestream sidecar, one pod, `Recreate`); `version-bump.mjs` sets its `appVersion` to each release; bump its own `version` by hand when the chart changes.
- `deploy/`: the production compose file (server and Litestream). HTTPS is left to the operator's own reverse proxy; keep anything host-specific out of it.

## Conventions

- After setup, never interrupt the user: no unprompted dialogues. Decide automatically, log the decision, show at most one plain notice, and respect 'Silence notifications'.
- User interface uses only Obsidian's own components (declarative settings, `Modal`, `Setting`, `Notice`); no UI framework.
- User-facing text is English, written in British English, without contractions.
- The server never reads note content: devices merge, encrypt, and decrypt.
- Do not stage or commit; the user reviews and commits.
- Test only in the testbench containers. Never start, open, or control the Obsidian app on the host.

Before changing synchronisation, run the test bench suites and several fuzz seeds; most bugs so far showed only there.

## Commands

```sh
cd plugin && bun install && bun run build   # plug-in into plugin/build/
cd plugin && bun run test                   # plug-in unit tests
cd server && cargo test                     # server tests; regenerates plugin/src/protocol/
cd testbench && docker compose up -d --build && bun install && bun run smoke
cd testbench && bun run sync && bun run sync:encrypted && bun run drill
cd testbench && bun run fuzz -- --seed 1 [--safe]   # random use of both devices; failures print the seed
cd testbench && docker compose exec server redsync-server user add <name>   # prints an invite code
```

The server is configured by environment variables: `REDSYNC_DATA` (data folder), `REDSYNC_STORE` (`s3://bucket/prefix` with the standard `AWS_*` variables, or `file:///path`), `REDSYNC_CACHE_MAX`, `REDSYNC_MAX_FILE`, `REDSYNC_SNAPSHOT_HOURS`, `REDSYNC_LISTEN`. Fixed limits are in `server/src/config.rs`.

Device A: https://localhost:3001 (DevTools port 9223). Device B: https://localhost:3002 (DevTools port 9224). Server: http://localhost:8080.
