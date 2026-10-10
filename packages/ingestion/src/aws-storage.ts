import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
} from "@aws-sdk/client-s3";
import type { ObjectStorage } from "./storage.js";
import type { Vault } from "../../security/src/crypto.js";
import { AppError } from "../../shared/src/errors.js";
export class S3EncryptedStorage implements ObjectStorage {
  constructor(
    private client: S3Client,
    private bucket: string,
    private vault: Vault,
    private kmsKeyId?: string,
    private localMirror?: ObjectStorage,
  ) {}
  private validate(key: string) {
    if (!/^[a-f0-9-]{36}\/[a-f0-9-]{36}$/.test(key))
      throw new AppError("INVALID_STORAGE_KEY");
  }
  async put(key: string, data: Buffer) {
    this.validate(key);
    // Only the LocalStack runtime supplies this encrypted, immutable recovery copy.
    await this.localMirror?.put(key, data);
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: this.vault.seal(data, key),
          ContentType: "application/octet-stream",
          IfNoneMatch: "*",
          ServerSideEncryption: this.kmsKeyId ? "aws:kms" : "AES256",
          ...(this.kmsKeyId ? { SSEKMSKeyId: this.kmsKeyId } : {}),
        }),
      );
    } catch (error) {
      if (
        (error as { $metadata?: { httpStatusCode?: number } }).$metadata
          ?.httpStatusCode !== 412
      )
        throw error;
      if (!(await this.get(key)).equals(data))
        throw new AppError("IMMUTABLE_UPLOAD_CONFLICT", 409);
    }
  }
  async get(key: string) {
    this.validate(key);
    let result;
    try {
      result = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
    } catch (error) {
      if ((error as { name?: string }).name === "NoSuchKey" && this.localMirror)
        return this.localMirror.get(key);
      throw error;
    }
    if (!result.Body) throw new AppError("STORAGE_OBJECT_MISSING", 503, true);
    return this.vault.open(
      Buffer.from(await result.Body.transformToByteArray()),
      key,
    );
  }
}
