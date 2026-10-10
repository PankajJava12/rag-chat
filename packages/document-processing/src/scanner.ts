import { createConnection } from "node:net";
import { AppError } from "../../shared/src/errors.js";
export interface MalwareScanner {
  scan(data: Buffer): Promise<void>;
}
export class ClamScanner implements MalwareScanner {
  constructor(
    private host: string,
    private port: number,
  ) {}
  scan(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host: this.host, port: this.port });
      let response = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve();
      };
      socket.setTimeout(60000, () =>
        finish(new AppError("SCANNER_UNAVAILABLE", 503, true)),
      );
      socket.on("error", () =>
        finish(new AppError("SCANNER_UNAVAILABLE", 503, true)),
      );
      socket.on("connect", () => {
        socket.write("zINSTREAM\0");
        for (let i = 0; i < data.length; i += 65536) {
          const chunk = data.subarray(i, i + 65536);
          const length = Buffer.alloc(4);
          length.writeUInt32BE(chunk.length);
          socket.write(length);
          socket.write(chunk);
        }
        socket.write(Buffer.alloc(4));
      });
      socket.on("data", (chunk) => {
        response += chunk.toString();
        if (response.length > 4096) {
          finish(new AppError("SCANNER_UNAVAILABLE", 503, true));
          return;
        }
        if (response.includes("\0")) {
          if (/\bFOUND\0/.test(response))
            finish(new AppError("MALWARE_DETECTED", 422));
          else if (/^stream: OK\0$/.test(response)) finish();
          else finish(new AppError("SCAN_REJECTED", 422));
        }
      });
      socket.on("end", () => {
        if (!settled) finish(new AppError("SCANNER_UNAVAILABLE", 503, true));
      });
    });
  }
}
