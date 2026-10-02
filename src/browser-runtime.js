import { chromium } from "playwright";
import fs from "node:fs/promises";

export function isProfileLockError(error) {
  const message = String(error?.message || error || "");
  return /ProcessSingleton|user data directory is already in use|profile.*in use|SingletonLock/i.test(message);
}

export function isMissingBrowserError(error) {
  const message = String(error?.message || error || "");
  return /Executable doesn't exist|browserType\.launch|No executable/i.test(message);
}

export function makeBrowserLaunchError({ channel, channelError, fallbackError, profileDir }) {
  const parts = [
    "Unable to launch the browser used by WYU Library Access.",
    "",
    `Profile: ${profileDir}`,
    `Preferred channel: ${channel || "(none)"}`,
    ""
  ];

  if (isProfileLockError(channelError) || isProfileLockError(fallbackError)) {
    parts.push(
      "The persistent browser profile appears to be in use.",
      "Close any Edge/Chromium window opened by this MCP service, or stop the MCP client that is holding the profile, then retry `npm run login`."
    );
  } else if (isMissingBrowserError(fallbackError)) {
    parts.push(
      "Playwright could not find its bundled Chromium browser.",
      "Fix options:",
      "1. Keep using system Edge by setting `WYULIB_BROWSER_CHANNEL=msedge` if Edge is installed.",
      "2. Install Playwright Chromium with `npx playwright install chromium`.",
      "3. Run `npm run doctor` to see browser availability."
    );
  } else {
    parts.push(
      "Run `npm run doctor` for a focused browser check.",
      "If Chromium is missing, run `npx playwright install chromium`."
    );
  }

  if (channelError) {
    parts.push("", `Channel launch error: ${String(channelError.message || channelError).split("\n")[0]}`);
  }
  if (fallbackError) {
    parts.push(`Fallback Chromium error: ${String(fallbackError.message || fallbackError).split("\n")[0]}`);
  }

  return new Error(parts.join("\n"));
}

export async function launchPersistentBrowser(profileDir, options = {}) {
  await fs.mkdir(profileDir, { recursive: true });
  const {
    visible = false,
    channel = process.env.WYULIB_BROWSER_CHANNEL || "msedge",
    acceptDownloads = true
  } = options;
  const launchBase = {
    headless: !visible,
    acceptDownloads,
    ...(visible ? { viewport: null } : {})
  };

  let channelError = null;
  if (channel) {
    try {
      return await chromium.launchPersistentContext(profileDir, {
        ...launchBase,
        channel
      });
    } catch (error) {
      channelError = error;
      if (isProfileLockError(error)) {
        throw makeBrowserLaunchError({ channel, channelError, profileDir });
      }
    }
  }

  try {
    return await chromium.launchPersistentContext(profileDir, launchBase);
  } catch (fallbackError) {
    throw makeBrowserLaunchError({ channel, channelError, fallbackError, profileDir });
  }
}
