import type {
  CodexConnectionRepository,
  PersistedCodexConnection,
  VersionedCodexConnection,
} from "./types.ts";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class MemoryCodexConnectionRepository
  implements CodexConnectionRepository
{
  private readonly records = new Map<string, VersionedCodexConnection>();

  async load(userId: string): Promise<VersionedCodexConnection | null> {
    const record = this.records.get(userId);
    return record ? clone(record) : null;
  }

  async commit(
    userId: string,
    expectedRevision: number | null,
    next: PersistedCodexConnection | null,
  ): Promise<boolean> {
    const current = this.records.get(userId);
    if ((current?.revision ?? null) !== expectedRevision) return false;
    if (next === null) {
      this.records.delete(userId);
    } else {
      this.records.set(userId, {
        revision: (current?.revision ?? 0) + 1,
        value: clone(next),
      });
    }
    return true;
  }
}
