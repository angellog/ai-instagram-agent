import { randomBytes, scrypt as scryptCb, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { many, one } from "../db/pool.js";
import { sha256 } from "../lib/crypto.js";
import { PermanentError } from "../lib/errors.js";

/**
 * Accounts for the tenant set-up. The operator is the admin (the ADMIN_TOKEN
 * login, or an admin user); each influencer's business gets tenant users that
 * only ever see that one influencer. Passwords are scrypt-hashed; session and
 * invite tokens are random and stored only as SHA-256 hashes.
 */

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export type Role = "admin" | "tenant";
export interface User {
  id: number;
  email: string;
  name: string;
  role: Role;
  influencer_id: number | null;
  status: "invited" | "active" | "disabled";
  created_at: Date;
  last_login_at: Date | null;
}

/** Who is making a request. */
export type Principal = { kind: "admin"; userId: number | null; label: string } | { kind: "tenant"; userId: number; influencerId: number; label: string };

export const SESSION_DAYS = 14;
export const INVITE_DAYS = 7;
export const MIN_PASSWORD = 10;

export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(pw, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

export async function verifyPassword(pw: string, stored: string | null): Promise<boolean> {
  if (!stored?.startsWith("scrypt$")) return false;
  const [, saltHex, keyHex] = stored.split("$");
  const key = await scrypt(pw, Buffer.from(saltHex, "hex"), 64);
  const want = Buffer.from(keyHex, "hex");
  return want.length === key.length && timingSafeEqual(want, key);
}

const token = () => randomBytes(32).toString("base64url");
const hashToken = (t: string) => sha256(Buffer.from(t));

/** Admin creates a user and gets a one-time invite link token (shown once). */
export async function inviteUser(o: { email: string; name?: string; role: Role; influencerId?: number | null; by: string }): Promise<{ user: User; inviteToken: string }> {
  const email = o.email.trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new PermanentError("that doesn't look like an email address");
  if (o.role === "tenant" && !o.influencerId) throw new PermanentError("a tenant user belongs to one influencer: pick it");
  if (await one("SELECT 1 FROM users WHERE email = $1", [email])) throw new PermanentError("a user with that email already exists");
  const invite = token();
  const user = (await one<User>(
    `INSERT INTO users (email, name, role, influencer_id, status, invite_token_hash, invite_expires_at, created_by)
     VALUES ($1, $2, $3, $4, 'invited', $5, now() + make_interval(days => $6), $7)
     RETURNING id, email, name, role, influencer_id, status, created_at, last_login_at`,
    [email, (o.name ?? "").trim().slice(0, 80), o.role, o.role === "tenant" ? o.influencerId : null, hashToken(invite), INVITE_DAYS, o.by],
  ))!;
  return { user, inviteToken: invite };
}

/** A fresh invite link for an existing user (lost link, or a password reset). */
export async function reissueInvite(userId: number): Promise<string> {
  const invite = token();
  const r = await one("UPDATE users SET invite_token_hash = $2, invite_expires_at = now() + make_interval(days => $3) WHERE id = $1 RETURNING id", [userId, hashToken(invite), INVITE_DAYS]);
  if (!r) throw new PermanentError("user not found");
  return invite;
}

export async function userForInvite(inviteToken: string): Promise<User | undefined> {
  return (
    (await one<User>(
      "SELECT id, email, name, role, influencer_id, status, created_at, last_login_at FROM users WHERE invite_token_hash = $1 AND invite_expires_at > now() AND status <> 'disabled'",
      [hashToken(inviteToken)],
    )) ?? undefined
  );
}

/** Accept an invite: set the password, activate, burn the token. */
export async function acceptInvite(inviteToken: string, password: string): Promise<User> {
  const u = await userForInvite(inviteToken);
  if (!u) throw new PermanentError("this invite link has expired or was already used: ask for a new one");
  if (password.length < MIN_PASSWORD) throw new PermanentError(`use at least ${MIN_PASSWORD} characters`);
  await one("UPDATE users SET password_hash = $2, status = 'active', invite_token_hash = NULL, invite_expires_at = NULL WHERE id = $1", [u.id, await hashPassword(password)]);
  await one("DELETE FROM sessions WHERE user_id = $1", [u.id]); // a reset signs out everywhere
  return { ...u, status: "active" };
}

export async function login(email: string, password: string): Promise<User | undefined> {
  const row = await one<User & { password_hash: string | null }>("SELECT * FROM users WHERE email = $1 AND status = 'active'", [email.trim().toLowerCase()]);
  // Always run a hash so a missing user takes as long as a wrong password.
  const ok = await verifyPassword(password, row?.password_hash ?? "scrypt$00$00");
  if (!row || !ok) return undefined;
  await one("UPDATE users SET last_login_at = now() WHERE id = $1", [row.id]);
  return row;
}

export async function createSession(userId: number, userAgent?: string): Promise<string> {
  const t = token();
  await one("INSERT INTO sessions (id, user_id, expires_at, user_agent) VALUES ($1, $2, now() + make_interval(days => $3), $4)", [hashToken(t), userId, SESSION_DAYS, (userAgent ?? "").slice(0, 200)]);
  return t;
}

export async function endSession(t: string): Promise<void> {
  await one("DELETE FROM sessions WHERE id = $1", [hashToken(t)]);
}

/** The principal behind a session token, or undefined (expired, disabled, unknown). */
export async function principalForSession(t: string): Promise<Principal | undefined> {
  const r = await one<{ user_id: number; role: Role; influencer_id: number | null; email: string; last_seen_at: Date }>(
    `SELECT s.user_id, u.role, u.influencer_id, u.email, s.last_seen_at FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.id = $1 AND s.expires_at > now() AND u.status = 'active'`,
    [hashToken(t)],
  );
  if (!r) return undefined;
  if (Date.now() - new Date(r.last_seen_at).getTime() > 10 * 60_000) await one("UPDATE sessions SET last_seen_at = now() WHERE id = $1", [hashToken(t)]);
  if (r.role === "tenant") {
    if (!r.influencer_id) return undefined;
    return { kind: "tenant", userId: Number(r.user_id), influencerId: Number(r.influencer_id), label: r.email };
  }
  return { kind: "admin", userId: Number(r.user_id), label: r.email };
}

export async function listUsers(): Promise<Array<User & { influencer_name: string | null }>> {
  return many(
    `SELECT u.id, u.email, u.name, u.role, u.influencer_id, u.status, u.created_at, u.last_login_at, i.name AS influencer_name
     FROM users u LEFT JOIN influencers i ON i.id = u.influencer_id ORDER BY u.role, i.name NULLS FIRST, u.email`,
  );
}

export async function setUserStatus(userId: number, status: "active" | "disabled"): Promise<void> {
  await one("UPDATE users SET status = $2 WHERE id = $1 AND (status <> 'invited' OR $2 = 'disabled')", [userId, status]);
  if (status === "disabled") await one("DELETE FROM sessions WHERE user_id = $1", [userId]);
}
