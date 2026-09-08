import fs from 'fs';
import os from 'os';
import path from 'path';

const LEGACY_DIR = path.join(os.homedir(), '.x402');
const DIR =
  process.env.SPIGOT_CONFIG_DIR ||
  process.env.X402_CONFIG_DIR ||
  (fs.existsSync(path.join(LEGACY_DIR, 'config.json')) &&
  !fs.existsSync(path.join(os.homedir(), '.spigot', 'config.json'))
    ? LEGACY_DIR
    : path.join(os.homedir(), '.spigot'));
const FILE = path.join(DIR, 'config.json');

export const DEFAULT_API =
  process.env.SPIGOT_API_URL || process.env.X402_API_URL || 'http://localhost:4402';

export const readConfig = () => {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return {};
  }
};

/**
 * The session token is a real credential, so the file is written 0600 — readable only by
 * the user who owns it, the same treatment an SSH key or cloud CLI credential gets.
 */
export const writeConfig = patch => {
  const next = { ...readConfig(), ...patch };
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
  fs.writeFileSync(FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
  return next;
};

export const clearConfig = () => {
  try {
    fs.unlinkSync(FILE);
  } catch {
    // Already gone — signing out twice is not an error.
  }
};

export const configPath = () => FILE;
