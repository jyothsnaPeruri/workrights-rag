// Admin authentication.
//
// There is deliberately no visitor sign-up: a login wall on a public demo costs
// you almost every visitor. Only the admin authenticates, and the only thing it
// unlocks is the model-provider switch.
//
// Password storage: scrypt, from node:crypto. scrypt is memory-hard, so it
// resists GPU cracking in a way a plain SHA-256 digest does not, and it avoids
// a native bcrypt dependency. The password itself is never stored or logged —
// only a salt and the derived key, and the hash is produced on the admin's own
// machine by `npm run admin:hash`.

import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import jwt from "jsonwebtoken";
import { optionalEnv } from "../scripts/http.mjs";

const scrypt = promisify(scryptCallback);

const KEY_LENGTH = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 };
const TOKEN_TTL = "8h";

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

/** Constant-time comparison, so response timing can't leak how much matched. */
async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored).split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length, SCRYPT_PARAMS);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export const adminConfigured = () =>
  Boolean(process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD_HASH && process.env.JWT_SECRET);

/** Returns a signed token, or null when the credentials don't match. */
export async function login(username, password) {
  if (!adminConfigured()) return null;
  if (typeof username !== "string" || typeof password !== "string") return null;

  // Check the password even when the username is wrong, so a bad username and a
  // bad password take the same time and can't be told apart by an attacker.
  const expectedUser = Buffer.from(optionalEnv("ADMIN_USERNAME") ?? "");
  const givenUser = Buffer.from(username);
  const userMatches =
    expectedUser.length === givenUser.length && timingSafeEqual(expectedUser, givenUser);
  const passwordMatches = await verifyPassword(password, optionalEnv("ADMIN_PASSWORD_HASH"));

  if (!userMatches || !passwordMatches) return null;
  return jwt.sign({ role: "admin" }, optionalEnv("JWT_SECRET"), {
    subject: username,
    expiresIn: TOKEN_TTL,
  });
}

/** True when the request carries a valid, unexpired admin token. */
export function isAdmin(req) {
  if (!adminConfigured()) return false;
  const header = req.get("authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return false;
  try {
    return jwt.verify(token, optionalEnv("JWT_SECRET")).role === "admin";
  } catch {
    // Expired or tampered with: not an error worth logging, just not an admin.
    return false;
  }
}
