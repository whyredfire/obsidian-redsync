# Red Sync: notes for coding assistants

Red Sync synchronises Obsidian vaults between a person's own devices through a self-hosted server, with Cloudflare R2 as the long-term backup. Several people (a family) can share one server; each owns their own vaults. The design is in `docs/design.md` (kept out of git).

## Layout

- `plugin/`: the Obsidian plug-in (TypeScript, Bun, esbuild). Plug-in ID `red-sync`; needs Obsidian 1.13.0 or later.
- `server/`: the sync server (Rust, axum, SQLite). `src/protocol.rs` defines every message; `cargo test` regenerates their TypeScript types in `plugin/src/protocol/` (commit them, never edit them by hand).
- `testbench/`: docker compose with two Obsidian containers (devices A and B) and the server, plus scripts that drive the devices over the Chrome DevTools Protocol.

## Conventions

- After setup, never interrupt the user: no unprompted dialogues. Decide automatically, log the decision, show at most one plain notice, and respect 'Silence notifications'.
- User interface uses only Obsidian's own components (declarative settings, `Modal`, `Setting`, `Notice`); no UI framework.
- User-facing text is English, written in British English, without contractions.
- The server never reads note content: devices merge, encrypt, and decrypt.
- Do not stage or commit; the user reviews and commits.
- Test only in the testbench containers. Never start, open, or control the Obsidian app on the host.

## Commands

```sh
cd plugin && bun install && bun run build   # plug-in into plugin/build/
cd plugin && bun run test                   # plug-in unit tests
cd server && cargo test                     # server tests; regenerates plugin/src/protocol/
cd testbench && docker compose up -d --build && bun install && bun run smoke
```

Device A: https://localhost:3001 (DevTools port 9223). Device B: https://localhost:3002 (DevTools port 9224). Server: http://localhost:8080.
