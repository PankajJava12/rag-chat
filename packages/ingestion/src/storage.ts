import { randomUUID } from "node:crypto";
import { mkdir, readFile, open, link, unlink } from "node:fs/promises";
import { join } from "node:path";
import { Vault } from "../../security/src/crypto.js";
import { AppError } from "../../shared/src/errors.js";
export interface ObjectStorage {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer>;
}
export class LocalEncryptedStorage implements ObjectStorage {
  constructor(
    private directory: string,
    private vault: Vault,
  ) {}
  private path(key: string) {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))
      throw new AppError("INVALID_STORAGE_KEY");
    return join(this.directory, ...key.split("/"));
  }
  async put(key: string, data: Buffer) {
    const path = this.path(key);
    await mkdir(join(this.directory, key.split("/")[0]!), {
      recursive: true,
      mode: 0o700,
    });
    // Publish a fully written encrypted file atomically; a crash cannot leave a partial final object.
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(this.vault.seal(data, key));
        await file.sync();
      } finally {
        await file.close();
      }
      try {
        await link(temporary, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        if (!(await this.get(key)).equals(data))
          throw new AppError("IMMUTABLE_UPLOAD_CONFLICT", 409);
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  }
  async get(key: string) {
    return this.vault.open(await readFile(this.path(key)), key);
  }
}
