import { readFileSync } from 'node:fs';
import { decodeJwt } from 'jose';

/**
 * Read the workload's SPIFFE ID (the SVID's `sub`) synchronously from a file
 * written by the spiffe-helper sidecar. Used at OTel SDK init to set the
 * `spiffe.id` resource attribute, so it must be sync (runs before async setup).
 *
 * Decodes WITHOUT signature verification — we trust the file source (same
 * trust assumption as SpiffeJwtSvidSource). Returns null if the file is
 * missing or empty so the caller can fall back to 'unknown'.
 */
export function readSpiffeIdSync(filePath: string): string | null {
  let raw: string;
  try {
    raw = readFileSync(filePath, 'utf8').trim();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  if (!raw) return null;
  const sub = decodeJwt(raw).sub;
  return typeof sub === 'string' ? sub : null;
}
