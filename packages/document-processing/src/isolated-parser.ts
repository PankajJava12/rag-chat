import { Worker } from "node:worker_threads";
import { join, resolve as resolvePath } from "node:path";
import { existsSync } from "node:fs";
import type { FileType } from "./validate.js";
import type { ParsedSection } from "./parsers.js";
import { AppError } from "../../shared/src/errors.js";
export function isolatedParse(
  data: Buffer,
  type: FileType,
): Promise<ParsedSection[]> {
  return new Promise((resolve, reject) => {
    const local = join(__dirname, "parse-task.js");
    const worker = new Worker(
      existsSync(local)
        ? local
        : resolvePath("dist/packages/document-processing/src/parse-task.js"),
      {
        workerData: { data, type },
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      },
    );
    const timer = setTimeout(
      () => {
        void worker.terminate();
        reject(new AppError("PARSE_TIMEOUT"));
      },
      5 * 60 * 1000,
    );
    worker.once(
      "message",
      (message: { sections?: ParsedSection[]; error?: string }) => {
        clearTimeout(timer);
        void worker.terminate();
        if (message.sections) resolve(message.sections);
        else reject(new AppError(message.error ?? "DOCUMENT_PARSE_FAILED"));
      },
    );
    worker.once("error", () => {
      clearTimeout(timer);
      reject(new AppError("DOCUMENT_PARSE_FAILED"));
    });
    worker.once("exit", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new AppError("PARSER_RESOURCE_LIMIT"));
    });
  });
}
