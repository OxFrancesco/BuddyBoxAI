import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { EnvelopeProtector } from "./crypto";
import type { EncryptedEnvelope } from "./types";

export interface SecureVault {
  get<T>(namespace: string, id: string): Promise<T | undefined>;
  put(namespace: string, id: string, value: unknown): Promise<void>;
  listIds(namespace: string): Promise<string[]>;
  delete(namespace: string, id: string): Promise<void>;
  update<T, R>(
    namespace: string,
    id: string,
    change: (current: T | undefined) => { next: T | undefined; result: R; write?: boolean },
  ): Promise<R>;
}

interface VaultFile {
  format: 1;
  records: Record<string, EncryptedEnvelope>;
}

export class EncryptedFileVault implements SecureVault {
  readonly #path: string;
  readonly #protector: EnvelopeProtector;
  #mutation: Promise<void> = Promise.resolve();

  constructor(path: string, protector: EnvelopeProtector) {
    if (!path.startsWith("/")) throw new TypeError("Vault path must be absolute");
    this.#path = path;
    this.#protector = protector;
  }

  async get<T>(namespace: string, id: string): Promise<T | undefined> {
    await this.#mutation;
    const key = recordKey(namespace, id);
    const file = await this.#read();
    const envelope = file.records[key];
    return envelope ? await this.#protector.open<T>(envelope, `xchat:vault:${key}`) : undefined;
  }

  async put(namespace: string, id: string, value: unknown): Promise<void> {
    const key = recordKey(namespace, id);
    const envelope = await this.#protector.seal(value, `xchat:vault:${key}`);
    await this.#enqueue(async () => {
      const file = await this.#read();
      file.records[key] = envelope;
      await this.#write(file);
    });
  }

  async listIds(namespace: string): Promise<string[]> {
    await this.#mutation;
    const prefix = `${checkedNamespace(namespace)}:`;
    const file = await this.#read();
    return Object.keys(file.records)
      .filter((key) => key.startsWith(prefix))
      .map((key) => key.slice(prefix.length));
  }

  async delete(namespace: string, id: string): Promise<void> {
    const key = recordKey(namespace, id);
    await this.#enqueue(async () => {
      const file = await this.#read();
      if (!(key in file.records)) return;
      delete file.records[key];
      await this.#write(file);
    });
  }

  async update<T, R>(
    namespace: string,
    id: string,
    change: (current: T | undefined) => { next: T | undefined; result: R; write?: boolean },
  ): Promise<R> {
    const key = recordKey(namespace, id);
    return await this.#enqueue(async () => {
      const file = await this.#read();
      const envelope = file.records[key];
      const current = envelope
        ? await this.#protector.open<T>(envelope, `xchat:vault:${key}`)
        : undefined;
      const { next, result, write = true } = change(current);
      if (!write) return result;
      if (next === undefined) delete file.records[key];
      else file.records[key] = await this.#protector.seal(next, `xchat:vault:${key}`);
      await this.#write(file);
      return result;
    });
  }

  #enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#mutation.then(operation, operation);
    this.#mutation = result.then(() => undefined, () => undefined);
    return result;
  }

  async #write(file: VaultFile): Promise<void> {
    await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
    const temporary = `${this.#path}.${process.pid}.tmp`;
    await writeFile(temporary, JSON.stringify(file), { encoding: "utf8", mode: 0o600 });
    await chmod(temporary, 0o600);
    await rename(temporary, this.#path);
  }

  async #read(): Promise<VaultFile> {
    let raw: string;
    try {
      raw = await readFile(this.#path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { format: 1, records: {} };
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.format !== 1 || !isRecord(value.records)) {
      throw new Error("Vault file is malformed");
    }
    return value as unknown as VaultFile;
  }
}

export class MemoryVault implements SecureVault {
  readonly #records = new Map<string, unknown>();
  async get<T>(namespace: string, id: string): Promise<T | undefined> {
    return this.#records.get(recordKey(namespace, id)) as T | undefined;
  }
  async put(namespace: string, id: string, value: unknown): Promise<void> {
    this.#records.set(recordKey(namespace, id), structuredClone(value));
  }
  async listIds(namespace: string): Promise<string[]> {
    const prefix = `${checkedNamespace(namespace)}:`;
    return [...this.#records.keys()].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
  }
  async delete(namespace: string, id: string): Promise<void> {
    this.#records.delete(recordKey(namespace, id));
  }
  async update<T, R>(
    namespace: string,
    id: string,
    change: (current: T | undefined) => { next: T | undefined; result: R; write?: boolean },
  ): Promise<R> {
    const key = recordKey(namespace, id);
    const current = this.#records.get(key) as T | undefined;
    const { next, result, write = true } = change(current === undefined ? undefined : structuredClone(current));
    if (!write) return result;
    if (next === undefined) this.#records.delete(key);
    else this.#records.set(key, structuredClone(next));
    return result;
  }
}

function recordKey(namespace: string, id: string): string {
  if (!/^[a-zA-Z0-9:_-]{1,256}$/.test(id)) {
    throw new TypeError("Invalid vault record identity");
  }
  return `${checkedNamespace(namespace)}:${id}`;
}

function checkedNamespace(namespace: string): string {
  if (!/^[a-z_]{2,32}$/.test(namespace)) throw new TypeError("Invalid vault namespace");
  return namespace;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
