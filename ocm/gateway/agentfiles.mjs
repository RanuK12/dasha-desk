/**
 * The agent files this gateway serves, and their checksums.
 *
 * An agent's version is the SHA-256 of agent.py, nothing else: there is no number to
 * bump, forget, or lie about. The gateway hashes the file it serves; an agent hashes
 * the file it runs and reports it at hello. Equal means current. Anything else means
 * `ocm-agent-update` has work to do, and the console, the status page and the doctor
 * all say so (ROADMAP P2).
 */
import { readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const AGENT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'agent');

// Cached by mtime and size: the files only change on deploy, and the hash must be
// computed from the bytes on disk so it cannot drift from what is served.
const cache = new Map();
export async function fileSha256(file) {
  try {
    const path = join(AGENT_DIR, file);
    const { mtimeMs, size } = await stat(path);
    const hit = cache.get(file);
    if (hit && hit.mtimeMs === mtimeMs && hit.size === size) return hit.hex;
    const hex = createHash('sha256').update(await readFile(path)).digest('hex');
    cache.set(file, { mtimeMs, size, hex });
    return hex;
  } catch {
    return null;   // never let a missing file take a page down
  }
}
export const installSha256 = () => fileSha256('install.sh');
export const agentSha256 = () => fileSha256('agent.py');

/** First twelve hex characters: enough to tell builds apart, short enough to print. */
export const shortBuild = (hex) => (hex ? hex.slice(0, 12) : null);

/**
 * current    — the host runs exactly the agent this gateway serves
 * stale      — the host reported a build and it is not this one
 * unreported — the host's agent predates build reporting; it is behind by definition
 * unknown    — this gateway cannot hash its own agent file (should not happen)
 */
export function buildState(hostBuild, served) {
  if (!served) return 'unknown';
  if (!hostBuild) return 'unreported';
  return hostBuild === served ? 'current' : 'stale';
}
export const updateAvailable = (state) => state === 'stale' || state === 'unreported';
