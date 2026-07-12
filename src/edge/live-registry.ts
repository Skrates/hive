import type { Provider } from "../domain.js";

export interface LiveIngress {
  actor: string;
  provider: Provider;
  callbackUrl: string;
  sessionId: string | null;
  surfaceVersion: string;
  expiresAt: number;
}

export class LiveIngressRegistry {
  private readonly entries = new Map<string, LiveIngress>();

  register(input: Omit<LiveIngress, "expiresAt">, ttlMs: number): LiveIngress {
    const entry = { ...input, expiresAt: Date.now() + ttlMs };
    this.entries.set(key(input.actor, input.provider), entry);
    return entry;
  }

  get(actor: string, provider: Provider): LiveIngress | null {
    const entry = this.entries.get(key(actor, provider));
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key(actor, provider));
      return null;
    }
    return entry;
  }
}

function key(actor: string, provider: Provider): string {
  return `${actor}:${provider}`;
}
