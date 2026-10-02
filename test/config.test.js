import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadLocalEnv, rootDir } from "../src/config.js";

test("dotenv handles quoted values, comments and environment precedence", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wyulib-config-test-"));
  try {
    const filename = path.join(dir, ".env");
    await fs.writeFile(filename, [
      '# synthetic values, not credentials',
      'QUOTED="example # with spaces = yes"',
      'SINGLE=\'example # single\'',
      'PLAIN=value # comment',
      'OVERRIDE=file',
      'EMPTY=file',
      'export EXPORTED=value'
    ].join("\n"));
    const target = { OVERRIDE: "environment", EMPTY: "" };
    loadLocalEnv(filename, target);
    assert.deepEqual(target, {
      QUOTED: "example # with spaces = yes", SINGLE: "example # single",
      PLAIN: "value", OVERRIDE: "environment", EMPTY: "", EXPORTED: "value"
    });
    assert.doesNotThrow(() => loadLocalEnv(path.join(dir, "missing"), {}));
    assert.throws(() => loadLocalEnv(dir, {}));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test("configured relative paths resolve from the project, not client cwd", () => {
  const configUrl = new URL("../src/config.js", import.meta.url).href;
  const output = execFileSync(process.execPath, ["--input-type=module", "-e",
    `const c = await import(${JSON.stringify(configUrl)}); console.log(JSON.stringify([c.profileDir, c.downloadDir]));`
  ], {
    cwd: os.tmpdir(), encoding: "utf8",
    env: { ...process.env, WYULIB_BROWSER_PROFILE: "test-profile", WYULIB_DOWNLOAD_DIR: "test-downloads" }
  });
  assert.deepEqual(JSON.parse(output), [path.join(rootDir, "test-profile"), path.join(rootDir, "test-downloads")]);
});
