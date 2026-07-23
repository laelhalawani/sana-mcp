/**
 * Minimal single-domain cookie jar. Sana auth is entirely cookie-based
 * (sana-ai-session + a CSRF cookie), all on sana.ai, so a flat name->value map
 * is sufficient. We deliberately ignore path/expiry nuances.
 */
export class CookieJar {
  private jar = new Map<string, string>();

  /** Absorb Set-Cookie headers from a fetch Response. */
  ingest(res: Response): void {
    // Node 18.14+ exposes getSetCookie(); fall back to a single header.
    const anyHeaders = res.headers as unknown as {
      getSetCookie?: () => string[];
    };
    const list = anyHeaders.getSetCookie
      ? anyHeaders.getSetCookie()
      : (res.headers.get("set-cookie") ? [res.headers.get("set-cookie")!] : []);
    for (const line of list) {
      const first = line.split(";")[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;
      // A cookie set to "deleted"/empty clears it.
      if (value === "" || value === "deleted") this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  header(): string {
    return [...this.jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  has(name: string): boolean {
    return this.jar.has(name);
  }

  get size(): number {
    return this.jar.size;
  }

  toJSON(): Record<string, string> {
    return Object.fromEntries(this.jar);
  }

  static fromJSON(obj: Record<string, string> | undefined | null): CookieJar {
    const jar = new CookieJar();
    if (obj) for (const [k, v] of Object.entries(obj)) jar.jar.set(k, v);
    return jar;
  }
}
