#!/usr/bin/env node

import { chromium } from "playwright";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { profileDir } from "./config.js";

const channel = process.env.WYULIB_BROWSER_CHANNEL || "msedge";

async function checkLaunch(label, launch) {
  try {
    const browser = await launch();
    await browser.close();
    return { label, ok: true };
  } catch (error) {
    return {
      label,
      ok: false,
      error: String(error?.message || error).split("\n")[0]
    };
  }
}

const tempProfile = await fs.mkdtemp(path.join(os.tmpdir(), "wyu-library-access-"));
const checks = [];

checks.push({
  label: "node",
  ok: Number(process.versions.node.split(".")[0]) >= 22,
  version: process.versions.node
});
checks.push({
  label: "profileDir",
  ok: true,
  path: profileDir
});
checks.push(await checkLaunch(`system channel: ${channel}`, () =>
  chromium.launchPersistentContext(tempProfile, { channel, headless: true })
));
checks.push(await checkLaunch("playwright chromium", () =>
  chromium.launch({ headless: true })
));
await fs.rm(tempProfile, { recursive: true, force: true });

const nodeOk = checks.find(check => check.label === "node")?.ok;
const browserOk = checks.some(check => ["system channel: " + channel, "playwright chromium"].includes(check.label) && check.ok);

console.log(JSON.stringify({ ok: Boolean(nodeOk && browserOk), checks }, null, 2));

if (!nodeOk || !browserOk) {
  console.log("");
  console.log("If Playwright Chromium is missing, run:");
  console.log("  npx playwright install chromium");
  console.log("");
  console.log("If the profile is locked, close the MCP browser window or stop the MCP client, then retry.");
  process.exitCode = 1;
} else if (checks.some(check => !check.ok)) {
  console.log("");
  console.log("At least one browser works. The failed browser check is only informational.");
}
