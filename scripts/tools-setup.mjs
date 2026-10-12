import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const directory = fileURLToPath(new URL("../.local/pgadmin/", import.meta.url));
const passwordFile = `${directory}password`;
mkdirSync(directory, { recursive: true, mode: 0o700 });
chmodSync(directory, 0o700);
if (!existsSync(passwordFile)) {
  // Compose mounts this file for the container's UID 5050. Protect its
  // containing directory on the host while allowing the container to read it.
  writeFileSync(passwordFile, `${randomBytes(24).toString("base64url")}\n`, {
    mode: 0o644,
    flag: "wx",
  });
}
console.log(
  "pgAdmin login: admin@advisor.example.com. Password is in .local/pgadmin/password (not printed). Existing password preserved.",
);
