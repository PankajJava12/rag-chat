import { extname } from "node:path";
import yauzl from "yauzl";
import { AppError } from "../../shared/src/errors.js";
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
export const MIME_TYPES = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  csv: "text/csv",
} as const;
export type FileType = keyof typeof MIME_TYPES;
export function fileType(name: string, mime: string): FileType {
  const extension = extname(name).slice(1).toLowerCase() as FileType;
  if (!Object.hasOwn(MIME_TYPES, extension) || MIME_TYPES[extension] !== mime)
    throw new AppError("UNSUPPORTED_FILE_TYPE", 415);
  if (
    [...name].some((c) => c === "/" || c === "\\" || c.charCodeAt(0) < 32) ||
    name.length > 200
  )
    throw new AppError("INVALID_FILE_NAME");
  return extension;
}
export async function inspectOfficeZip(
  data: Buffer,
  type: "docx" | "xlsx",
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    yauzl.fromBuffer(
      data,
      { lazyEntries: true, validateEntrySizes: true },
      (error, zip) => {
        if (error || !zip) {
          reject(new AppError("INVALID_OFFICE_FILE"));
          return;
        }
        let total = 0,
          count = 0;
        const names = new Set<string>();
        let settled = false;
        const fail = () => {
          if (!settled) {
            settled = true;
            zip.close();
            reject(new AppError("UNSAFE_OFFICE_ARCHIVE"));
          }
        };
        zip.on("error", fail);
        zip.on("entry", (entry: yauzl.Entry) => {
          count++;
          total += entry.uncompressedSize;
          if (
            count > 2000 ||
            total > 64 * 1024 * 1024 ||
            entry.uncompressedSize > 32 * 1024 * 1024 ||
            entry.uncompressedSize / Math.max(1, entry.compressedSize) > 200 ||
            entry.generalPurposeBitFlag & 1 ||
            /(^\/|\.\.|vbaProject|embeddings\/)/i.test(entry.fileName) ||
            names.has(entry.fileName)
          ) {
            fail();
            return;
          }
          names.add(entry.fileName);
          zip.readEntry();
        });
        zip.on("end", () => {
          if (settled) return;
          settled = true;
          if (
            !names.has("[Content_Types].xml") ||
            !names.has(
              type === "docx" ? "word/document.xml" : "xl/workbook.xml",
            )
          )
            reject(new AppError("OFFICE_TYPE_MISMATCH"));
          else resolve();
        });
        zip.readEntry();
      },
    );
  });
}
export async function validateBytes(data: Buffer, type: FileType) {
  if (!data.length || data.length > MAX_UPLOAD_BYTES)
    throw new AppError("INVALID_FILE_SIZE", 413);
  if (type === "pdf") {
    if (data.subarray(0, 5).toString() !== "%PDF-")
      throw new AppError("FILE_SIGNATURE_MISMATCH");
    if (
      /\/(JavaScript|JS|Launch|EmbeddedFile|Encrypt)\b/.test(
        data.toString("latin1"),
      )
    )
      throw new AppError("UNSAFE_PDF");
  } else if (type === "docx" || type === "xlsx") {
    if (data.length < 4 || data.readUInt32LE(0) !== 0x04034b50)
      throw new AppError("FILE_SIGNATURE_MISMATCH");
    await inspectOfficeZip(data, type);
  } else {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(data);
    } catch {
      throw new AppError("CSV_REQUIRES_UTF8");
    }
    if (data.includes(0)) throw new AppError("FILE_SIGNATURE_MISMATCH");
  }
}
