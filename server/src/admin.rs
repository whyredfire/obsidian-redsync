//! The `redsync-server` commands the server owner runs: users, invites, quotas, devices.

use anyhow::{Context, Result, bail};
use rusqlite::{Connection, OptionalExtension, params};

use crate::config::{DEFAULT_QUOTA, INVITE_TTL_MS, format_size, parse_size};
use crate::db::{code_hash, human_code, now_ms, random_id};

pub const USAGE: &str = "Usage:
  redsync-server [serve]                       run the server
  redsync-server user add <name> [--quota 10GB] add a user and print an invite code
  redsync-server user invite <name>            print a new invite code (one vault each)
  redsync-server user list                     users, vaults, devices, and storage used
  redsync-server user quota <name> <size>      change a user's quota
  redsync-server user remove <name>            revoke all devices; data is deleted after 30 days
  redsync-server device revoke <device-id>     disconnect one device
  redsync-server snapshot                      write a snapshot of every changed vault now
  redsync-server restore                       rebuild a missing database from the snapshots in R2
  redsync-server export <vault-id> <folder>    write a vault's newest snapshot as plain files, without a server
                                               (REDSYNC_PASSPHRASE for an encrypted vault)";

pub fn run(c: &Connection, args: &[&str]) -> Result<String> {
    match args {
        ["user", "add", name] => user_add(c, name, parse_size(DEFAULT_QUOTA)?),
        ["user", "add", name, "--quota", size] => user_add(c, name, parse_size(size)?),
        ["user", "invite", name] => invite(c, &user_id(c, name)?).map(|code| invite_message(name, &code)),
        ["user", "list"] => user_list(c),
        ["user", "quota", name, size] => {
            let bytes = parse_size(size)?;
            c.execute("UPDATE users SET quota_bytes = ?1 WHERE id = ?2", params![bytes, user_id(c, name)?])?;
            Ok(format!("{name} now has {}.", format_size(bytes)))
        }
        ["user", "remove", name] => {
            let id = user_id(c, name)?;
            c.execute("UPDATE users SET removed_at = ?1 WHERE id = ?2", params![now_ms(), id])?;
            let revoked = c.execute("UPDATE devices SET revoked = 1 WHERE vault_id IN (SELECT id FROM vaults WHERE user_id = ?1)", [&id])?;
            Ok(format!("{name} is removed and {revoked} devices are disconnected. Their data is deleted in 30 days."))
        }
        ["device", "revoke", id] => match c.execute("UPDATE devices SET revoked = 1 WHERE id = ?1 AND revoked = 0", [id])? {
            0 => bail!("no active device {id}"),
            _ => Ok(format!("Device {id} is disconnected.")),
        },
        _ => bail!("{USAGE}"),
    }
}

fn user_id(c: &Connection, name: &str) -> Result<String> {
    c.query_row("SELECT id FROM users WHERE name = ?1 AND removed_at IS NULL", [name], |r| r.get(0))
        .optional()?
        .with_context(|| format!("no user named {name}"))
}

fn user_add(c: &Connection, name: &str, quota: i64) -> Result<String> {
    if name.is_empty() || name.len() > 100 || name.chars().any(char::is_whitespace) {
        bail!("a user name has 1 to 100 characters and no spaces");
    }
    let id = random_id();
    c.execute("INSERT INTO users(id, name, quota_bytes, created_at) VALUES(?1, ?2, ?3, ?4)", params![id, name, quota, now_ms()])
        .with_context(|| format!("could not add {name} (does the user exist already?)"))?;
    Ok(invite_message(name, &invite(c, &id)?))
}

fn invite(c: &Connection, user_id: &str) -> Result<String> {
    let code = human_code();
    c.execute(
        "INSERT INTO invites(code_hash, user_id, expires_at) VALUES(?1, ?2, ?3)",
        params![code_hash(&code), user_id, now_ms() + INVITE_TTL_MS],
    )?;
    Ok(code)
}

fn invite_message(name: &str, code: &str) -> String {
    format!("Invite code for {name}: {code}\nIt creates one vault and expires in 7 days.")
}

fn user_list(c: &Connection) -> Result<String> {
    let mut out = String::new();
    let mut users = c.prepare(
        "SELECT u.id, u.name, u.quota_bytes, u.removed_at,
           (SELECT COALESCE(SUM(b.size), 0) FROM blobs b JOIN vaults v ON v.id = b.vault_id WHERE v.user_id = u.id)
         FROM users u ORDER BY u.name",
    )?;
    let rows = users.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get(2)?, r.get::<_, Option<i64>>(3)?, r.get(4)?)))?;
    for row in rows {
        let (id, name, quota, removed, used): (String, String, i64, Option<i64>, i64) = row?;
        let state = if removed.is_some() { "  (removed)" } else { "" };
        out += &format!("{name}: {} of {}{state}\n", format_size(used), format_size(quota));
        let mut vaults = c.prepare("SELECT id, name, head_seq FROM vaults WHERE user_id = ?1 ORDER BY created_at")?;
        for vault in vaults.query_map([&id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))? {
            let (vault_id, vault_name, head) = vault?;
            out += &format!("  vault {vault_name} ({vault_id}), {head} changes\n");
            let mut devices = c.prepare("SELECT id, name, last_seen, revoked FROM devices WHERE vault_id = ?1 ORDER BY created_at")?;
            for device in devices.query_map([&vault_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, Option<i64>>(2)?, r.get::<_, bool>(3)?))
            })? {
                let (device_id, device_name, last_seen, revoked) = device?;
                let seen = match last_seen {
                    Some(t) => format!("last seen {} min ago", (now_ms() - t) / 60_000),
                    None => "never connected".into(),
                };
                let revoked = if revoked { ", revoked" } else { "" };
                out += &format!("    device {device_name} ({device_id}), {seen}{revoked}\n");
            }
        }
    }
    Ok(if out.is_empty() { "No users yet. Add one with: redsync-server user add <name>".into() } else { out.trim_end().into() })
}
