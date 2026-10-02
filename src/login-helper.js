#!/usr/bin/env node

import { profileDir } from "./config.js";
import { launchPersistentBrowser as launchBrowserProfile } from "./browser-runtime.js";

const SEARCH_PAGE = "https://lib.wyu.edu.cn/articlesearch/web_searchingResult";
const LOGIN_PAGE =
  "https://authserver.wyu.edu.cn/authserver/login?service=https%3A%2F%2Flib.wyu.edu.cn%2Fcas%2Fcas%2Flogin%3Fservice%3Dhttps%253A%252F%252Flib.wyu.edu.cn%252Farticlesearch%252Fweb_searchingResult%26orgcode%3Dwyu%26oauth_provider%3DthirdProvider";

async function readLoginState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const userText = text.match(/欢迎来到五邑大学图书馆！\s*([^\n]+)\s*退出/)?.[1] || "";
    return {
      title: document.title,
      url: location.href,
      loggedIn: text.includes("退出") && !text.includes("请登录"),
      userText,
      needsCaptcha: text.includes("验证码") || Boolean(document.querySelector("#sliderCaptchaDiv, [class*=slider]")),
      textHead: text.slice(0, 300)
    };
  });
}

const context = await launchBrowserProfile(profileDir, { visible: true });
const page = context.pages()[0] || (await context.newPage());
await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(1500);

let state = await readLoginState(page).catch(() => null);
if (!state?.loggedIn) {
  await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded" });
}

console.log("Opened WYU CAS login in the persistent MCP browser profile.");
console.log("Finish login manually in the browser window. This helper will close after login succeeds.");

const deadline = Date.now() + Number(process.env.WYULIB_LOGIN_TIMEOUT_MS || 10 * 60_000);
while (Date.now() < deadline) {
  await page.waitForTimeout(2000);
  state = await readLoginState(page).catch(() => null);
  if (state?.loggedIn) {
    console.log(JSON.stringify({ loggedIn: true, userText: state.userText, url: state.url }, null, 2));
    await context.close();
    process.exit(0);
  }
}

console.log(JSON.stringify({ loggedIn: false, lastState: state }, null, 2));
await context.close();
process.exit(1);
