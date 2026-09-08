import { readConfig, DEFAULT_API } from './config.mjs';

export class ApiError extends Error {
  constructor(message, status, body) {
    super(message);
    this.status = status;
    this.body = body;
  }
}

export const baseUrl = () => (readConfig().apiUrl || DEFAULT_API).replace(/\/$/, '');

/**
 * All CLI traffic authenticates with `Authorization: Bearer <session token>` rather than a
 * cookie, and identifies itself with `x-client-type: cli` so the server returns the raw
 * token at sign-in instead of only setting an httpOnly cookie.
 */
export const request = async (path, { method = 'GET', body, auth = true } = {}) => {
  const { token } = readConfig();

  if (auth && !token) {
    throw new ApiError('Not signed in. Run: spigot login', 401);
  }

  const res = await fetch(`${baseUrl()}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'x-client-type': 'cli',
      ...(auth && token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  const text = await res.text();
  let parsed;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    parsed = { error: text };
  }

  if (!res.ok) {
    throw new ApiError(
      parsed?.error || parsed?.message || `Request failed (${res.status})`,
      res.status,
      parsed,
    );
  }
  return parsed;
};
