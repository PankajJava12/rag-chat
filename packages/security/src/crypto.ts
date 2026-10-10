import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
const scrypt = promisify(scryptCallback);
export const hash = (input: string | Buffer) =>
  createHash("sha256").update(input).digest("hex");
export class Vault {
  private key: Buffer;
  constructor(key: string) {
    if (!/^[a-f0-9]{64}$/i.test(key))
      throw new Error("STORAGE_ENCRYPTION_KEY must be 32 bytes in hex");
    this.key = Buffer.from(key, "hex");
  }
  seal(data: Buffer, context: string): Buffer {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    cipher.setAAD(Buffer.from(context));
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);
    return Buffer.concat([
      Buffer.from("AA01"),
      iv,
      cipher.getAuthTag(),
      encrypted,
    ]);
  }
  open(data: Buffer, context: string): Buffer {
    if (data.subarray(0, 4).toString() !== "AA01")
      throw new Error("Unsupported ciphertext");
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      data.subarray(4, 16),
    );
    decipher.setAAD(Buffer.from(context));
    decipher.setAuthTag(data.subarray(16, 32));
    return Buffer.concat([
      decipher.update(data.subarray(32)),
      decipher.final(),
    ]);
  }
  fingerprint(text: string, context: string) {
    return createHmac("sha256", this.key)
      .update(context)
      .update("\0")
      .update(text)
      .digest("hex");
  }
  sealText(text: string, context: string) {
    return this.seal(Buffer.from(text), context).toString("base64");
  }
  openText(text: string, context: string) {
    return this.open(Buffer.from(text, "base64"), context).toString("utf8");
  }
}
export async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16).toString("hex");
  return `scrypt:${salt}:${((await scrypt(password, salt, 64)) as Buffer).toString("hex")}`;
}
export async function verifyPassword(
  password: string,
  encoded: string,
): Promise<boolean> {
  const [algorithm, salt, digest] = encoded.split(":");
  if (algorithm !== "scrypt" || !salt || !digest) return false;
  const actual = (await scrypt(password, salt, 64)) as Buffer;
  const expected = Buffer.from(digest, "hex");
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
