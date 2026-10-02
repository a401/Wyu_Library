import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const rootDir = fileURLToPath(new URL("../", import.meta.url));

// Keep the server, login helper and doctor on the same browser profile.
// Existing environment variables (including empty values) take precedence.
export function loadLocalEnv(envPath, target = process.env) {
  let text;
  try {
    text = fs.readFileSync(envPath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  for (const [key, value] of Object.entries(parseEnv(text))) {
    if (!Object.hasOwn(target, key)) target[key] = value;
  }
}

loadLocalEnv(path.join(rootDir, ".env"));

export const profileDir = path.resolve(rootDir, process.env.WYULIB_BROWSER_PROFILE || "browser-profile");
export const downloadDir = path.resolve(rootDir, process.env.WYULIB_DOWNLOAD_DIR || "downloads");
