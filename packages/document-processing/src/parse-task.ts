import { parentPort, workerData } from "node:worker_threads";
import { parseDocument } from "./parsers.js";
import { AppError } from "../../shared/src/errors.js";
void parseDocument(Buffer.from(workerData.data), workerData.type)
  .then((sections) => parentPort?.postMessage({ sections }))
  .catch((error) =>
    parentPort?.postMessage({
      error: error instanceof AppError ? error.code : "DOCUMENT_PARSE_FAILED",
    }),
  );
