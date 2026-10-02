#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import path from "node:path";
import { profileDir, downloadDir } from "./config.js";
import { launchPersistentBrowser } from "./browser-runtime.js";

const DEFAULT_DELIVERY_EMAIL = process.env.WYULIB_DELIVERY_EMAIL || "";

const ORG_CODE = "wyu";
const LIB_ORIGIN = "https://lib.wyu.edu.cn";
const API_BASE = `${LIB_ORIGIN}/gateway`;
const SEARCH_PAGE = `${LIB_ORIGIN}/articlesearch/web_searchingResult`;
const ASSIST_CAPTCHA_DEFAULT = process.env.WYULIB_ASSIST_CAPTCHA_DEFAULT !== "0";
const AUTO_LOGIN_DEFAULT = process.env.WYULIB_AUTO_LOGIN !== "0";
const LOGIN_PAGE =
  "https://authserver.wyu.edu.cn/authserver/login?service=https%3A%2F%2Flib.wyu.edu.cn%2Fcas%2Fcas%2Flogin%3Fservice%3Dhttps%253A%252F%252Flib.wyu.edu.cn%252Farticlesearch%252Fweb_searchingResult%26orgcode%3Dwyu%26oauth_provider%3DthirdProvider";

let basicTokenCache = null;
let browserContext = null;
let browserPage = null;
let deliveryPage = null;
let browserVisible = null;

function jsonText(value) {
  return {
    content: [
      {
        type: "text",
        text: typeof value === "string" ? value : JSON.stringify(value, null, 2)
      }
    ]
  };
}

function randomKey(prefix = "U") {
  const n = Math.floor(10000000 + Math.random() * 90000000);
  return `@${prefix}_${n}_0_f`;
}

function buildSearchBody({ keyword, pageIndex = 1, pageSize = 10, field = "U", matchType = "fuzzy", sort = "" }) {
  const key = randomKey(field);
  const ruleBodyByMatch = {
    fuzzy: `${field}=${key}`,
    accurate: `${field}=[${key}]`,
    prefix: `${field}={${key}}`,
    contain: `${field}=[${key}}`,
    phrase: `${field}={${key}]`
  };
  return {
    aggsField: null,
    usePreference: false,
    sortTypes: "",
    rule: {
      ruleBody: ruleBodyByMatch[matchType] || ruleBodyByMatch.fuzzy,
      ruleParameters: [{ value: keyword, key, displayValue: null }]
    },
    filterRule: { ruleBody: "", ruleParameters: [] },
    sort,
    sortMode: null,
    searchFilterRule: { ruleBody: "", ruleParameters: [] },
    rf: { ruleBody: "", ruleParameters: [] },
    requestAggsType: 1,
    pageIndex,
    pageSize,
    keywords: keyword,
    useCE: null,
    useSynonym: null
  };
}

async function getBasicToken() {
  if (basicTokenCache && basicTokenCache.expiresAt > Date.now() + 60_000) {
    return basicTokenCache.token;
  }

  const response = await fetch(`${LIB_ORIGIN}/jwt/api/Auth/AccessToken`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "user-agent": "Mozilla/5.0",
      origin: LIB_ORIGIN,
      referer: SEARCH_PAGE
    },
    body: JSON.stringify({ orgCode: ORG_CODE })
  });
  if (!response.ok) {
    throw new Error(`BasicToken request failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  const token = data?.data?.token;
  if (!token) {
    throw new Error("BasicToken response did not contain data.token");
  }
  const expiresAtRaw = data?.data?.tokenExpiredAt;
  const expiresAt = expiresAtRaw ? new Date(expiresAtRaw).getTime() : Date.now() + 30 * 60_000;
  basicTokenCache = { token, expiresAt: Number.isFinite(expiresAt) ? expiresAt : Date.now() + 30 * 60_000 };
  return token;
}

async function apiRequest(url, options = {}) {
  const token = options.userToken || (await getBasicToken());
  const response = await fetch(`${API_BASE}${url}`, {
    ...options,
    headers: {
      accept: "application/json, text/plain, */*",
      "user-agent": "Mozilla/5.0",
      origin: LIB_ORIGIN,
      referer: SEARCH_PAGE,
      authorization: `Bearer ${token}`,
      ...(options.body ? { "content-type": "application/json" } : {}),
      ...(options.headers || {})
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`API ${url} failed: HTTP ${response.status}${text ? ` ${text.slice(0, 300)}` : ""}`);
  }
  return text ? JSON.parse(text) : null;
}

function simplifyHit(hit) {
  return {
    id: hit.id ?? hit._id,
    title: hit.title,
    type: hit.type,
    author: hit.author,
    journalName: hit.journalName,
    publisher: hit.publisher,
    publishYear: hit.publishYear,
    volume: hit.volume,
    issue: hit.issue,
    doi: hit.doi,
    hasOPAC: hit.hasOPAC ?? false,
    deliveryShow: hit.deliveryShow ?? false,
    sources: (hit.sourceCollection || hit.sourceLinkList || []).slice(0, 10).map(source => ({
      title: source.title || source.name,
      platform: source.platform,
      provider: source.provider,
      isOA: Boolean(source.isOA),
      isDownload: Boolean(source.isDownload),
      originalAddress: source.originalAddress,
      rawUrl: source.rawUrl,
      url: source.url
    }))
  };
}

function normalizeText(value) {
  return String(value || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[’']/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

function normalizeDoi(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/^https?:\/\/(dx\.)?doi\.org\//, "")
    .trim();
}

function textTokens(value) {
  return normalizeText(value)
    .split(" ")
    .filter(token => token.length > 1);
}

function scoreCandidate(candidate, { query, targetTitle, doi }) {
  const title = normalizeText(candidate.title);
  const queryText = normalizeText(query);
  const titleTarget = normalizeText(targetTitle || "");
  const target = titleTarget || queryText;
  const targetTokens = textTokens(target);
  const titleTokens = new Set(textTokens(candidate.title));
  const candidateDoi = normalizeDoi(candidate.doi);
  const targetDoi = normalizeDoi(doi);
  const reasons = [];
  let score = 0;

  if (targetDoi && candidateDoi) {
    if (candidateDoi === targetDoi) {
      score += 1000;
      reasons.push("DOI exact match");
    } else if (candidateDoi.includes(targetDoi) || targetDoi.includes(candidateDoi)) {
      score += 450;
      reasons.push("DOI partial match");
    }
  }

  if (target) {
    if (title === target) {
      score += 520;
      reasons.push("title exact match");
    } else if (title.startsWith(target)) {
      score += 180;
      reasons.push("title starts with query");
    } else if (title.includes(target)) {
      score += 110;
      reasons.push("title contains query");
    }

    if (targetTokens.length) {
      const overlap = targetTokens.filter(token => titleTokens.has(token));
      const ratio = overlap.length / targetTokens.length;
      score += Math.round(ratio * 160);
      if (ratio === 1) {
        score += 80;
        reasons.push("all query tokens present");
      } else if (ratio >= 0.6) {
        reasons.push("most query tokens present");
      }
    }
  }

  if (candidateDoi) {
    score += 25;
    reasons.push("has DOI");
  }
  const sourceCount = candidate.sources?.length || 0;
  if (sourceCount) {
    score += Math.min(sourceCount, 8) * 5;
    reasons.push(`${sourceCount} source(s)`);
  }
  if (candidate.type === 3) {
    score += 8;
  }

  score += Math.max(0, 40 - textTokens(candidate.title).length);
  score -= Math.min(candidate.bestApiRank || 0, 50) * 0.4;

  return { score: Math.round(score * 10) / 10, reasons };
}

async function searchLiteratureData(args) {
  const body = buildSearchBody(args);
  const data = await apiRequest("/articlesearch/api/search/asset-search@4", {
    method: "POST",
    body: JSON.stringify(body)
  });
  if (data?.statusCode && data.statusCode !== 200) {
    return { keyword: args.keyword, total: 0, results: [], raw: data };
  }
  const hits = data?.data?.hits || {};
  return {
    keyword: args.keyword,
    total: hits.total || 0,
    results: (hits.source || []).map(simplifyHit)
  };
}

async function findBestLiterature({ query, targetTitle = "", doi = "", pageSize = 30, requestDeliveryUrl = false }) {
  const keyword = targetTitle || doi || query;
  const shortQuery = textTokens(query).length <= 2;
  const size = Math.min(Math.max(pageSize, 5), 50);
  const strategies = [];

  if (doi) {
    strategies.push({ label: "doi:DI", args: { keyword: doi, field: "DI", matchType: "fuzzy", pageSize: size } });
    strategies.push({ label: "doi:U", args: { keyword: doi, field: "U", matchType: "fuzzy", pageSize: size } });
  }

  if (keyword) {
    strategies.push({ label: "title:phrase", args: { keyword, field: "T", matchType: "phrase", pageSize: size } });
    strategies.push({ label: "title:fuzzy", args: { keyword, field: "T", matchType: "fuzzy", pageSize: size } });
    strategies.push({ label: "all:fuzzy", args: { keyword, field: "U", matchType: "fuzzy", pageSize: size } });
  }

  if (shortQuery && query && query !== keyword) {
    strategies.push({ label: "short:title:prefix", args: { keyword: query, field: "T", matchType: "prefix", pageSize: 50 } });
    strategies.push({ label: "short:title:fuzzy", args: { keyword: query, field: "T", matchType: "fuzzy", pageSize: 50 } });
  } else if (shortQuery && query) {
    strategies.push({ label: "short:title:prefix", args: { keyword: query, field: "T", matchType: "prefix", pageSize: 50 } });
  }

  const candidates = new Map();
  const searches = [];
  for (const strategy of strategies) {
    const result = await searchLiteratureData({
      pageIndex: 1,
      sort: "",
      ...strategy.args
    });
    searches.push({ strategy: strategy.label, total: result.total, count: result.results.length });
    result.results.forEach((record, index) => {
      const key = String(record.id || `${normalizeText(record.title)}|${normalizeDoi(record.doi)}`);
      const existing = candidates.get(key);
      if (existing) {
        existing.searchStrategies.push(strategy.label);
        existing.bestApiRank = Math.min(existing.bestApiRank, index + 1);
      } else {
        candidates.set(key, {
          ...record,
          bestApiRank: index + 1,
          searchStrategies: [strategy.label]
        });
      }
    });
  }

  const ranked = Array.from(candidates.values())
    .map(candidate => {
      const scored = scoreCandidate(candidate, { query, targetTitle, doi });
      return { ...candidate, matchScore: scored.score, matchReasons: scored.reasons };
    })
    .sort((a, b) => b.matchScore - a.matchScore);

  const best = ranked[0] || null;
  const runnerUp = ranked[1] || null;
  const confidence =
    !best ? "none" :
    best.matchScore >= 700 || (best.matchScore >= 350 && (!runnerUp || best.matchScore - runnerUp.matchScore >= 80)) ? "high" :
    best.matchScore >= 220 && (!runnerUp || best.matchScore - runnerUp.matchScore >= 35) ? "medium" :
    "low";

  const response = {
    query,
    targetTitle,
    doi,
    confidence,
    searches,
    best,
    candidates: ranked.slice(0, 8)
  };

  if (requestDeliveryUrl && best?.id) {
    response.delivery = await callDeliveryInBrowser(best.id);
  }

  return response;
}

async function ensureBrowser({ visible = false } = {}) {
  if (browserContext && browserPage && (!visible || browserVisible)) {
    return { context: browserContext, page: browserPage };
  }

  if (browserContext) {
    await browserContext.close().catch(() => {});
    browserContext = null;
    browserPage = null;
    deliveryPage = null;
    browserVisible = null;
  }

  browserContext = await launchPersistentBrowser(profileDir, { visible });

  browserPage = browserContext.pages()[0] || (await browserContext.newPage());
  browserVisible = visible;
  return { context: browserContext, page: browserPage };
}

async function ensureSearchPage(options = {}) {
  const { page } = await ensureBrowser(options);
  if (!page.url().startsWith(LIB_ORIGIN)) {
    await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
  }
  return page;
}

async function checkLoggedIn(page) {
  await page.goto(SEARCH_PAGE, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText || "";
      return text.includes("欢迎来到五邑大学图书馆") || text.includes("请登录") || text.includes("退出");
    },
    { timeout: 8000 }
  ).catch(() => {});
  await page.waitForTimeout(500);
  const state = await page.evaluate(() => {
    const text = document.body?.innerText || "";
    const nameLink = Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({ text: a.textContent?.trim() || "", href: a.href }))
      .find(a => a.href.includes("/usermanage/web_library"));
    return {
      title: document.title,
      url: location.href,
      loggedIn: text.includes("退出") && !text.includes("请登录"),
      userText: nameLink?.text || text.match(/欢迎来到五邑大学图书馆！\s*([^\n]+)\s*退出/)?.[1] || "",
      hasLogout: text.includes("退出"),
      hasLoginPrompt: text.includes("请登录")
    };
  });
  return state;
}

async function readCurrentLoginState(page) {
  await page.waitForTimeout(250);
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const nameLink = Array.from(document.querySelectorAll("a[href]"))
      .map(a => ({ text: a.textContent?.trim() || "", href: a.href }))
      .find(a => a.href.includes("/usermanage/web_library"));
    return {
      title: document.title,
      url: location.href,
      loggedIn: text.includes("退出") && !text.includes("请登录"),
      userText: nameLink?.text || text.match(/欢迎来到五邑大学图书馆！\s*([^\n]+)\s*退出/)?.[1] || "",
      hasLogout: text.includes("退出"),
      hasLoginPrompt: text.includes("请登录"),
      needsSlider: /请完成安全验证|向右滑动|拖动滑块|滑块/.test(text)
    };
  });
}

function getLoginCredentials() {
  const username = process.env.WYULIB_USER || process.env.WYU_USER || "";
  const password = process.env.WYULIB_PASS || process.env.WYULIB_PASSWORD || process.env.WYU_PASS || "";
  return {
    username,
    password,
    available: Boolean(username && password)
  };
}

async function fillFirstVisible(page, selectors, value) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.fill(value);
        return selector;
      }
    }
  }
  return "";
}

async function clickFirstVisible(page, selectors) {
  for (const selector of selectors) {
    const locator = page.locator(selector).first();
    if (await locator.count().catch(() => 0)) {
      if (await locator.isVisible().catch(() => false)) {
        await locator.click();
        return selector;
      }
    }
  }
  return "";
}

async function solveCasSlider(page, attempts = 3) {
  const states = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.waitForTimeout(600);
    const geometry = await page.evaluate(attemptNumber => {
      function grayAt(data, width, x, y) {
        const idx = (y * width + x) * 4;
        return data[idx] * 0.299 + data[idx + 1] * 0.587 + data[idx + 2] * 0.114;
      }

      const canvases = Array.from(document.querySelectorAll("canvas"))
        .map(el => ({ el, box: el.getBoundingClientRect() }))
        .filter(item => item.box.width >= 150 && item.box.height >= 80)
        .sort((a, b) => b.box.width * b.box.height - a.box.width * a.box.height);
      const canvas = canvases[0]?.el || null;
      const canvasBox = canvases[0]?.box || null;

      const sliderCandidates = [];
      for (const el of document.querySelectorAll("*")) {
        const box = el.getBoundingClientRect();
        const text = el.textContent || "";
        const cls = el.className || "";
        const id = el.id || "";
        if (
          box.width >= 24 &&
          box.height >= 24 &&
          /slider|slide|drag|handler|btn|滑块/i.test(`${cls} ${id} ${text}`) &&
          box.x > 0 &&
          box.y > 0
        ) {
          sliderCandidates.push({
            x: box.x,
            y: box.y,
            width: box.width,
            height: box.height,
            text: text.slice(0, 20),
            cls: String(cls).slice(0, 80),
            id
          });
        }
      }

      const handle = sliderCandidates.sort((a, b) => a.width - b.width)[0] || null;
      if (!handle) {
        return { ok: false, reason: "no-slider-handle", candidateCount: sliderCandidates.length };
      }

      let analysis = null;
      if (canvas) {
        try {
          const ctx = canvas.getContext("2d");
          const width = canvas.width;
          const height = canvas.height;
          const { data } = ctx.getImageData(0, 0, width, height);
          const edgeScores = [];
          for (let x = 2; x < width - 2; x++) {
            let score = 0;
            for (let y = 12; y < height - 12; y++) {
              const g = grayAt(data, width, x, y);
              const edge =
                Math.abs(grayAt(data, width, x + 1, y) - grayAt(data, width, x - 1, y)) +
                Math.abs(grayAt(data, width, x, y + 1) - grayAt(data, width, x, y - 1));
              if (edge > 38 && g < 210) {
                score += edge;
              }
            }
            edgeScores[x] = score;
          }

          const smooth = edgeScores.map((_, x) => {
            let total = 0;
            let count = 0;
            for (let dx = -4; dx <= 4; dx++) {
              const value = edgeScores[x + dx];
              if (Number.isFinite(value)) {
                total += value;
                count++;
              }
            }
            return count ? total / count : 0;
          });

          const leftLimit = Math.round(width * 0.26);
          const rightLimit = Math.round(width * 0.88);
          let bestX = leftLimit;
          let bestScore = -Infinity;
          for (let x = leftLimit; x <= rightLimit; x++) {
            if ((smooth[x] || 0) > bestScore) {
              bestScore = smooth[x];
              bestX = x;
            }
          }

          let pieceX = Math.round(width * 0.08);
          let pieceScore = -Infinity;
          for (let x = 5; x < leftLimit; x++) {
            if ((smooth[x] || 0) > pieceScore) {
              pieceScore = smooth[x];
              pieceX = x;
            }
          }

          const scale = canvasBox.width / width;
          const adjustment = attemptNumber === 2 ? -7 : attemptNumber === 3 ? 7 : 0;
          const targetDelta = Math.max(80, Math.min(230, (bestX - pieceX) * scale + adjustment));
          analysis = {
            canvasWidth: width,
            canvasCssWidth: Math.round(canvasBox.width),
            targetX: bestX,
            pieceX,
            bestScore: Math.round(bestScore),
            pieceScore: Math.round(pieceScore),
            targetDelta: Math.round(targetDelta),
            adjustment
          };
        } catch (error) {
          analysis = { error: error.message };
        }
      }

      const fallbackDelta = canvasBox ? Math.max(100, Math.min(180, canvasBox.width * 0.46)) : 128;
      const targetDelta = analysis?.targetDelta || fallbackDelta;
      return {
        ok: true,
        analysis,
        targetDelta,
        startX: handle.x + handle.width / 2,
        startY: handle.y + handle.height / 2
      };
    }, attempt);

    if (!geometry.ok) {
      states.push({ attempt, ok: false, reason: geometry.reason, candidates: geometry.candidateCount });
      break;
    }

    await page.mouse.move(geometry.startX, geometry.startY);
    await page.mouse.down();
    for (let i = 1; i <= 42; i++) {
      const t = i / 42;
      const ease = 1 - Math.pow(1 - t, 2.2);
      await page.mouse.move(
        geometry.startX + geometry.targetDelta * ease,
        geometry.startY + Math.sin(t * Math.PI * 4) * 0.8
      );
      await page.waitForTimeout(12 + Math.floor(Math.random() * 18));
    }
    await page.mouse.up();
    await page.waitForTimeout(2500);

    const state = await readCurrentLoginState(page);
    states.push({
      attempt,
      geometry: geometry.analysis,
      delta: Math.round(geometry.targetDelta),
      loggedIn: state.loggedIn,
      needsSlider: state.needsSlider,
      url: state.url
    });
    if (state.loggedIn || !state.needsSlider) {
      break;
    }
  }
  return states;
}

async function autoLogin(page, { timeoutSeconds = 120 } = {}) {
  const credentials = getLoginCredentials();
  if (!credentials.available) {
    return {
      attempted: false,
      ok: false,
      needCredentials: true,
      message: "WYULIB_USER and WYULIB_PASS are not configured."
    };
  }

  const result = {
    attempted: true,
    ok: false,
    usedCredentials: true,
    casFilled: false,
    casClicked: false,
    casSliderAttempts: []
  };

  await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded", timeout: 30_000 });
  await page.waitForTimeout(1000);
  const userSelector = await fillFirstVisible(page, [
    "#username",
    "input[name='username']",
    "input[type='text']",
    "input[placeholder*='账号']",
    "input[placeholder*='用户名']"
  ], credentials.username);
  const passSelector = await fillFirstVisible(page, [
    "#password",
    "input[name='password']",
    "input[type='password']",
    "input[placeholder*='密码']"
  ], credentials.password);
  result.casFilled = Boolean(userSelector && passSelector);

  const clicked = await clickFirstVisible(page, [
    "#login_submit",
    "#loginSubmit",
    "button[type='submit']",
    "input[type='submit']",
    ".auth_login_btn",
    ".login-btn",
    "text=登录"
  ]);
  result.casClicked = Boolean(clicked);
  await page.waitForTimeout(2500);

  let state = await readCurrentLoginState(page);
  if (state.needsSlider) {
    result.casSliderAttempts = await solveCasSlider(page);
  }

  const deadline = Date.now() + Math.min(Math.max(timeoutSeconds, 10), 600) * 1000;
  while (Date.now() < deadline) {
    state = await readCurrentLoginState(page);
    if (state.loggedIn) {
      result.ok = true;
      result.status = state;
      return result;
    }
    if (state.url.startsWith(LIB_ORIGIN)) {
      const status = await checkLoggedIn(page);
      if (status.loggedIn) {
        result.ok = true;
        result.status = status;
        return result;
      }
    }
    await page.waitForTimeout(2000);
  }

  const status = await checkLoggedIn(page).catch(() => state);
  result.ok = Boolean(status?.loggedIn);
  result.status = status;
  result.message = result.ok
    ? "Auto login completed."
    : "Auto login did not complete; manual CAS verification may be required.";
  return result;
}

async function ensureLoggedIn(page, options = {}) {
  const status = await checkLoggedIn(page);
  if (status.loggedIn) {
    return {
      loggedIn: true,
      reusedSession: true,
      status,
      autoLogin: { attempted: false, ok: false }
    };
  }

  if (!AUTO_LOGIN_DEFAULT || options.autoLogin === false) {
    return {
      loggedIn: false,
      reusedSession: false,
      status,
      autoLogin: {
        attempted: false,
        ok: false,
        disabled: true,
        message: "Auto login is disabled by WYULIB_AUTO_LOGIN=0 or tool options."
      }
    };
  }

  const login = await autoLogin(page, {
    timeoutSeconds: Number(process.env.WYULIB_AUTO_LOGIN_TIMEOUT_SECONDS || 120)
  });
  return {
    loggedIn: Boolean(login.ok),
    reusedSession: false,
    status: login.status || status,
    autoLogin: login
  };
}

async function callDeliveryInBrowser(id, options = {}) {
  const page = await ensureSearchPage(options);
  const login = await ensureLoggedIn(page, options);
  if (!login.loggedIn) {
    return {
      ok: false,
      needLogin: true,
      needCredentials: Boolean(login.autoLogin?.needCredentials),
      message: login.autoLogin?.needCredentials
        ? "Persistent browser is not logged in, and WYULIB_USER/WYULIB_PASS are not configured."
        : "Persistent browser is not logged in, and auto login did not complete. Call open_login for manual CAS verification.",
      status: login.status,
      autoLogin: login.autoLogin
    };
  }

  await page.waitForFunction(
    () => Boolean(window["d-utils"]?.request),
    { timeout: 15_000 }
  ).catch(() => {});

  const result = await page.evaluate(async literatureId => {
    const utils = window["d-utils"];
    const endpoint = "/articlesearch/api/search-const/document-delivery";
    const gatewayEndpoint = `/gateway${endpoint}?id=${encodeURIComponent(literatureId)}`;

    if (utils?.request) {
      const response = await utils.request({
        url: endpoint,
        params: { id: literatureId }
      });
      return {
        via: "d-utils.request",
        data: response?.data?.data ?? response?.data ?? response ?? null
      };
    }

    const token =
      (utils?.token?.get && (await utils.token.get().catch(() => null))) ||
      (utils?.token?.getToken && (await utils.token.getToken().catch(() => null))) ||
      null;
    const response = await fetch(gatewayEndpoint, {
      headers: {
        accept: "application/json, text/plain, */*",
        ...(token ? { authorization: `Bearer ${token}` } : {})
      }
    });
    const text = await response.text();
    let data = text;
    try {
      data = JSON.parse(text);
    } catch {}
    return {
      via: "fetch",
      status: response.status,
      ok: response.ok,
      hasToken: Boolean(token),
      data: data?.data ?? data
    };
  }, String(id));

  return {
    ok: result?.ok !== false,
    id: String(id),
    via: result?.via,
    deliveryUrl: typeof result?.data === "string" ? result.data : null,
    result: result?.data ?? result,
    login: {
      reusedSession: login.reusedSession,
      autoLoginAttempted: Boolean(login.autoLogin?.attempted),
      autoLoginOk: Boolean(login.autoLogin?.ok)
    }
  };
}

async function readDeliveryPageState(page) {
  return page.evaluate(() => {
    const text = document.body?.innerText || "";
    const captchaModal = document.querySelector("#captcha-modal");
    const successModal = document.querySelector(".alert-cg-warp");
    return {
      url: location.href,
      title: document.title,
      literatureTitle: document.querySelector(".book-title a")?.textContent?.trim() || "",
      email: document.querySelector("#email")?.value || "",
      captchaVisible: captchaModal ? getComputedStyle(captchaModal).display !== "none" : false,
      successVisible: successModal ? getComputedStyle(successModal).display !== "none" : false,
      successText: successModal?.innerText?.trim() || "",
      verifyStatus: document.querySelector("#verifyStatus")?.textContent?.trim() || "",
      toast: Array.from(document.querySelectorAll(".jq-toast-single, .toast, [class*=toast]"))
        .map(element => element.innerText.trim())
        .filter(Boolean)
        .slice(-3),
      textTail: text.slice(-500)
    };
  });
}

async function solvePuzzleCaptcha(page, attempts = 3) {
  const states = [];
  for (let attempt = 1; attempt <= attempts; attempt++) {
    await page.waitForSelector("#puzzleSlider", { timeout: 15_000 });
    await page.waitForSelector("#puzzleCanvas", { timeout: 15_000 });
    await page.waitForTimeout(500);

    const geometry = await page.evaluate(() => {
      const canvas = document.querySelector("#puzzleCanvas");
      const slider = document.querySelector("#puzzleSlider");
      const track = document.querySelector(".puzzle-slider-track");
      const ctx = canvas.getContext("2d");
      const { width, height } = canvas;
      const image = ctx.getImageData(0, 0, width, height).data;
      let minX = width;
      let maxX = 0;
      let minY = height;
      let maxY = 0;
      let count = 0;

      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const alpha = image[(y * width + x) * 4 + 3];
          if (alpha < 20) {
            minX = Math.min(minX, x);
            maxX = Math.max(maxX, x);
            minY = Math.min(minY, y);
            maxY = Math.max(maxY, y);
            count++;
          }
        }
      }

      const sliderBox = slider.getBoundingClientRect();
      const maxMove = track.offsetWidth - 50;
      const targetCanvasX = count ? (minX + maxX) / 2 - 30 : 120;
      const targetDelta = (targetCanvasX / (width - 60)) * maxMove;
      return {
        count,
        minX,
        maxX,
        minY,
        maxY,
        targetCanvasX,
        targetDelta,
        startX: sliderBox.left + sliderBox.width / 2,
        startY: sliderBox.top + sliderBox.height / 2,
        endX: sliderBox.left + sliderBox.width / 2 + targetDelta,
        endY: sliderBox.top + sliderBox.height / 2
      };
    });

    await page.mouse.move(geometry.startX, geometry.startY);
    await page.mouse.down();
    for (let i = 1; i <= 45; i++) {
      const t = i / 45;
      const ease = t < 0.85 ? (1 - Math.pow(1 - t / 0.85, 2)) * 0.97 : 0.97 + ((t - 0.85) / 0.15) * 0.03;
      await page.mouse.move(
        geometry.startX + (geometry.endX - geometry.startX) * ease,
        geometry.startY + Math.sin(t * Math.PI * 5) * 0.6
      );
      await page.waitForTimeout(10 + Math.floor(Math.random() * 14));
    }
    await page.waitForTimeout(250);
    await page.mouse.up();
    await page.waitForTimeout(2500);

    const state = await readDeliveryPageState(page);
    states.push({ attempt, geometry, state });
    if (state.successVisible || /验证成功|正在提交/.test(`${state.verifyStatus} ${state.textTail}`)) {
      break;
    }
  }
  return states;
}

async function submitDocumentDelivery({ id, email, timeoutSeconds = 300, interactive = false, assistCaptcha = ASSIST_CAPTCHA_DEFAULT }) {
  const delivery = await callDeliveryInBrowser(id, { visible: interactive });
  if (!delivery.ok || !delivery.deliveryUrl) {
    return {
      ok: false,
      id: String(id),
      email,
      message: "Could not get document delivery URL.",
      delivery
    };
  }

  const { context } = await ensureBrowser({ visible: interactive });
  if (!deliveryPage || deliveryPage.isClosed()) {
    deliveryPage = await context.newPage();
  }

  await deliveryPage.goto(delivery.deliveryUrl, { waitUntil: "domcontentloaded" });
  await deliveryPage.waitForSelector("#email", { timeout: 20_000 });
  const literatureTitle = await deliveryPage.locator(".book-title a").textContent().catch(() => "");
  await deliveryPage.fill("#email", email);

  const timeoutMs = Math.min(Math.max(timeoutSeconds, 10), 600) * 1000;
  const responsePromise = deliveryPage
    .waitForResponse(response => response.url().includes("/documentdelivery/create"), { timeout: (interactive || assistCaptcha) ? timeoutMs : 3000 })
    .catch(error => ({ timeout: true, error: error.message }));

  await deliveryPage.click("#applydocumentdeliverybtn");

  await deliveryPage.waitForTimeout(1000);
  let state = await readDeliveryPageState(deliveryPage);
  let captchaAssistStates = [];
  if (state.captchaVisible && assistCaptcha) {
    captchaAssistStates = await solvePuzzleCaptcha(deliveryPage);
  } else if (state.captchaVisible && !interactive) {
    responsePromise.catch(() => {});
    return {
      ok: false,
      id: String(id),
      email,
      literatureTitle: literatureTitle?.trim() || state.literatureTitle,
      deliveryUrl: delivery.deliveryUrl,
      needCaptcha: true,
      interactiveRequired: true,
      message: "Captcha is required. Re-run submit_document_delivery with interactive=true for manual verification or assistCaptcha=true after explicit user authorization.",
      state
    };
  }

  const response = await responsePromise;

  let backend = null;
  if (response && !response.timeout) {
    backend = await response.json().catch(async () => response.text().catch(() => null));
  }

  await deliveryPage.waitForTimeout(500);
  state = await readDeliveryPageState(deliveryPage);
  const backendSuccess = Boolean(backend?.Success || backend?.success);
  const ok = backendSuccess || state.successVisible;

  return {
    ok,
    id: String(id),
    email,
    literatureTitle: literatureTitle?.trim() || state.literatureTitle,
    deliveryUrl: delivery.deliveryUrl,
    backend,
    captchaAssistStates,
    needCaptcha: !ok && state.captchaVisible,
    timedOut: Boolean(response?.timeout),
    message: ok
      ? "Document delivery request submitted."
      : state.captchaVisible
        ? "Captcha is visible in the browser. Complete it manually, then retry or inspect the page."
        : backend?.Message || backend?.message || response?.error || "Document delivery submission did not complete.",
    state
  };
}

const server = new McpServer({
  name: "wyu-library-access",
  version: "0.1.0"
}, {
  instructions: [
    "Use this MCP server whenever the user mentions WYU, wyu, WYU Library, wyu图书馆, 五邑大学图书馆, 图书馆检索, 文献检索, 查论文, 文献传递, document delivery, or asks to search literature through the university library.",
    "For broad literature searches, use search_literature. For a known title, DOI, acronym, or ambiguous paper request, prefer find_best_literature before requesting details or document delivery.",
    "The public literature search does not require login. Document delivery requires the persistent WYU browser session; call login_status or open_login when delivery needs authentication."
  ].join(" ")
});

server.registerTool(
  "search_literature",
  {
    title: "Search WYU Library Literature",
    description: "Search WYU Library / 五邑大学图书馆 unified literature search by keyword. Use when the user says wyu, wyu图书馆, 五邑大学图书馆, 图书馆检索, 文献检索, 查论文. Returns structured literature records.",
    inputSchema: {
      keyword: z.string().min(1).describe("Search keyword."),
      pageIndex: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(50).default(10),
      field: z.enum(["U", "T", "A", "K", "S", "P", "DI"]).default("U"),
      matchType: z.enum(["fuzzy", "accurate", "prefix", "contain", "phrase"]).default("fuzzy"),
      sort: z.string().default("")
    }
  },
  async args => {
    const result = await searchLiteratureData(args);
    return jsonText(result.raw ?? result);
  }
);

server.registerTool(
  "find_best_literature",
  {
    title: "Find Best Matching WYU Literature",
    description: "Find the best matching paper in WYU Library / 五邑大学图书馆. Use for known titles, DOI, acronyms, ambiguous paper names, 文献检索, 查论文, or when selecting one exact literature record before document delivery.",
    inputSchema: {
      query: z.string().min(1).describe("User search query, such as a title fragment, acronym, DOI, or keywords."),
      targetTitle: z.string().optional().default("").describe("Known full or near-full title, if available."),
      doi: z.string().optional().default("").describe("Known DOI, if available."),
      pageSize: z.number().int().min(5).max(50).default(30),
      requestDeliveryUrl: z.boolean().default(false).describe("Whether to also request the document delivery URL for the best match. This does not submit an email delivery form.")
    }
  },
  async args => {
    return jsonText(await findBestLiterature(args));
  }
);

server.registerTool(
  "get_literature_detail",
  {
    title: "Get WYU Literature Detail",
    description: "Fetch detail data for a WYU Library / 五邑大学图书馆 literature id returned by search_literature or find_best_literature.",
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe("Literature id returned by search_literature.")
    }
  },
  async ({ id }) => {
    const data = await apiRequest("/articlesearch/api/search/asset-details@3", {
      method: "POST",
      body: JSON.stringify({ ids: [String(id)] })
    });
    return jsonText(data?.data ?? data);
  }
);

server.registerTool(
  "open_login",
  {
    title: "Open WYU Library Login",
    description: "Open a persistent browser for manual WYU CAS login / 五邑大学统一认证登录. Use before document delivery if login_status says the user is not logged in.",
    inputSchema: {}
  },
  async () => {
    const { page } = await ensureBrowser({ visible: true });
    await page.goto(LOGIN_PAGE, { waitUntil: "domcontentloaded" });
    return jsonText({
      opened: true,
      message: "Finish CAS login manually in the opened browser. Then call login_status.",
      url: page.url()
    });
  }
);

server.registerTool(
  "login_status",
  {
    title: "Check WYU Library Login Status",
    description: "Check whether the persistent browser profile is logged into WYU Library / 五邑大学图书馆. If the saved session is logged out and credentials are configured, automatically restore login before returning status.",
    inputSchema: {}
  },
  async () => {
    const { page } = await ensureBrowser({ visible: false });
    const login = await ensureLoggedIn(page);
    return jsonText({
      ...login.status,
      loggedIn: login.loggedIn,
      reusedSession: login.reusedSession,
      autoLogin: {
        attempted: Boolean(login.autoLogin?.attempted),
        ok: Boolean(login.autoLogin?.ok),
        needCredentials: Boolean(login.autoLogin?.needCredentials),
        disabled: Boolean(login.autoLogin?.disabled),
        message: login.autoLogin?.message || ""
      }
    });
  }
);

server.registerTool(
  "request_document_delivery",
  {
    title: "Request Document Delivery URL",
    description: "Use the logged-in browser session to get the WYU Library / 五邑大学图书馆 document delivery URL for a literature id. Use when the user asks for 文献传递 or document delivery.",
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe("Literature id returned by search_literature."),
      openUrl: z.boolean().default(false).describe("Whether to open the returned delivery URL in the persistent browser.")
    }
  },
  async ({ id, openUrl }) => {
    const result = await callDeliveryInBrowser(id, { visible: openUrl });
    if (result.ok && openUrl && result.deliveryUrl) {
      const { page } = await ensureBrowser({ visible: true });
      await page.goto(result.deliveryUrl, { waitUntil: "domcontentloaded" });
      result.opened = true;
    }
    return jsonText(result);
  }
);

server.registerTool(
  "submit_document_delivery",
  {
    title: "Submit Document Delivery Request",
    description: "Open the WYU Library / 五邑大学图书馆 document delivery form, fill the email, and submit a real request. Use only after the user confirms the paper and recipient. Slider assistance is enabled by default; use interactive=true and assistCaptcha=false for manual verification.",
    inputSchema: {
      id: z.union([z.string(), z.number()]).describe("Literature id returned by search_literature or find_best_literature."),
      email: z.string().email().optional().describe("Recipient email. Defaults to WYULIB_DELIVERY_EMAIL when configured."),
      timeoutSeconds: z.number().int().min(10).max(600).default(300).describe("How long to wait for manual captcha completion and final submission."),
      interactive: z.boolean().default(false).describe("When true, open a visible browser window. For manual verification also set assistCaptcha=false. Default false keeps MCP headless; slider assistance may still submit the request."),
      assistCaptcha: z.boolean().default(ASSIST_CAPTCHA_DEFAULT).describe("Accessibility assist. When true, attempt to solve the rendered puzzle captcha by dragging the real slider with browser mouse events. This does not forge captcha tokens. Set WYULIB_ASSIST_CAPTCHA_DEFAULT=0 or pass false to disable.")
    }
  },
  async args => {
    const email = args.email || DEFAULT_DELIVERY_EMAIL;
    if (!email) {
      return jsonText({
        ok: false,
        message: "Recipient email is required. Pass email or configure WYULIB_DELIVERY_EMAIL."
      });
    }
    return jsonText(await submitDocumentDelivery({ ...args, email }));
  }
);

server.registerTool(
  "download_url",
  {
    title: "Download URL",
    description: "Download a URL, such as a document delivery email link, into the local downloads directory.",
    inputSchema: {
      url: z.string().url(),
      filename: z.string().optional()
    }
  },
  async ({ url, filename }) => {
    await fs.mkdir(downloadDir, { recursive: true });
    const response = await fetch(url, {
      headers: { "user-agent": "Mozilla/5.0" }
    });
    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }
    const arrayBuffer = await response.arrayBuffer();
    const cd = response.headers.get("content-disposition") || "";
    const fromHeader = /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd)?.[1];
    const safeName = (filename || fromHeader || path.basename(new URL(url).pathname) || `download-${Date.now()}`)
      .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
    const target = path.join(downloadDir, safeName);
    await fs.writeFile(target, Buffer.from(arrayBuffer));
    return jsonText({
      savedTo: target,
      bytes: arrayBuffer.byteLength,
      contentType: response.headers.get("content-type")
    });
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
