import { readFile, stat } from 'node:fs/promises';
import { watch, type FSWatcher } from 'node:fs';
import { decodeJwt } from 'jose';

/**
 * Decoded JWT-SVID claims. SPIFFE-issued tokens always carry `sub` as a
 * SPIFFE ID (the workload's identity) and `aud` as the audience set chosen
 * at fetch time by spiffe-helper.
 */
export interface JwtSvidClaims {
  iss: string;
  sub: string;
  aud: string | string[];
  exp: number;
  iat: number;
  [claim: string]: unknown;
}

export interface JwtSvid {
  /** Compact JWS string. */
  jwt: string;
  /** Claims decoded WITHOUT signature verification — we trust the file source. */
  claims: JwtSvidClaims;
  /** The audience this SVID was requested for. */
  audience: string;
  /** Absolute path of the file the SVID was read from. */
  filePath: string;
}

/**
 * One row in the SVID-source config: ties a logical audience to a file that
 * spiffe-helper writes the JWT into.
 */
export interface AudienceBinding {
  audience: string;
  filePath: string;
}

export interface SvidSourceConfig {
  audiences: AudienceBinding[];
}

type RotationHandler = (svid: JwtSvid) => void;

/**
 * Reads JWT-SVIDs written by spiffe-helper. Verification is intentionally not
 * the responsibility of this package — the file is sourced from a shared
 * tmpfs volume between sidecar and workload, so the trust boundary is the
 * pod. Consumers that need to verify SVIDs against the SPIRE bundle should
 * compose this with packages/auth-curity.
 */
export class SpiffeJwtSvidSource {
  private readonly bindings: ReadonlyMap<string, string>;
  private readonly handlers = new Set<RotationHandler>();
  private readonly watchers: FSWatcher[] = [];
  private closed = false;

  constructor(config: SvidSourceConfig) {
    this.bindings = new Map(config.audiences.map((b) => [b.audience, b.filePath]));
  }

  listAudiences(): string[] {
    return Array.from(this.bindings.keys());
  }

  /**
   * Read the current SVID for an audience. Returns null if the file isn't
   * present yet (e.g. spiffe-helper hasn't minted the first SVID), or the
   * audience isn't configured.
   */
  async getSvid(audience: string): Promise<JwtSvid | null> {
    const filePath = this.bindings.get(audience);
    if (!filePath) return null;
    try {
      const jwt = (await readFile(filePath, 'utf8')).trim();
      if (!jwt) return null;
      const claims = decodeJwt(jwt) as JwtSvidClaims;
      return { jwt, claims, audience, filePath };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  /**
   * Start watching every configured file for rotation. Each time spiffe-helper
   * rewrites a file, registered handlers are invoked with the new SVID.
   */
  async start(): Promise<void> {
    for (const [audience, filePath] of this.bindings) {
      // fs.watch needs the file to exist. If spiffe-helper hasn't written it
      // yet, skip — we'll poll on first getSvid() instead and the caller can
      // re-invoke start() after the file appears, OR upgrade this to watch
      // the parent dir.
      try {
        await stat(filePath);
      } catch {
        continue;
      }
      const watcher = watch(filePath, { persistent: false }, () => {
        void this.emit(audience);
      });
      this.watchers.push(watcher);
    }
  }

  onRotate(handler: RotationHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const w of this.watchers) w.close();
    this.watchers.length = 0;
    this.handlers.clear();
  }

  private async emit(audience: string): Promise<void> {
    const svid = await this.getSvid(audience);
    if (!svid) return;
    for (const h of this.handlers) h(svid);
  }
}
