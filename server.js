const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const ROOT_WITH_SEPARATOR = ROOT.endsWith(path.sep) ? ROOT : `${ROOT}${path.sep}`;

const mimeTypes = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

const PYTHON_COMMAND = process.env.PYTHON || "py";
const YAHOO_FETCH_SCRIPT = path.join(__dirname, "scripts", "fetch_yahoo_prices.py");
const YAHOO_CANDLE_SCRIPT = path.join(__dirname, "scripts", "fetch_yahoo_candles.py");
const DATA_DIR = path.join(__dirname, "data");
const BACKTEST_DATA_FILE = path.join(DATA_DIR, "backtest-prices.json");
const CANDLE_DATA_DIR = path.join(DATA_DIR, "candles");

const backtestSymbols = {
  sp500: { name: "标普500基金", ticker: "SPY", proxy: "SPDR S&P 500 ETF Trust" },
  nasdaq: { name: "纳指基金", ticker: "QQQ", proxy: "Invesco QQQ Trust" },
  bond: { name: "长期国债基金", ticker: "TLT", proxy: "iShares 20+ Year Treasury Bond ETF" },
  gold: { name: "黄金资产", ticker: "GLD", proxy: "SPDR Gold Shares" },
};

let backtestCache = null;
let backtestCacheTime = 0;
const candleCache = new Map();
const BACKTEST_CACHE_TTL = 1000 * 60 * 60 * 6;
const CANDLE_CACHE_TTL = 1000 * 60 * 60 * 6;
let marketContextCache = null;
let marketContextCacheTime = 0;
const MARKET_CONTEXT_CACHE_TTL = 1000 * 60 * 10;

const marketSources = [
  {
    id: "eastmoney-us-treasury",
    label: "东方财富中美国债收益率",
    url: "https://data.eastmoney.com/cjsj/zmgzsyl.html",
    why: "最新中美国债收益率、10Y-2Y 利差和收益率曲线状态",
  },
  {
    id: "eastmoney-us10y",
    label: "东方财富美国10年期国债收益率",
    url: "https://quote.eastmoney.com/unify/r/171.US10Y",
    why: "10年期美债收益率最新报价和债券市场新闻",
  },
  {
    id: "danjuan-sp500-valuation",
    label: "蛋卷基金标普500估值",
    url: "https://danjuanfunds.com/dj-valuation-table-detail/SP500",
    why: "标普500 PE、估值分位和估值高低判断",
  },
  {
    id: "macromicro-sp500-pe",
    label: "MacroMicro 财经M平方 S&P 500 市盈率",
    url: "https://sc.macromicro.me/series/1633/us-sp500-pe-ratio",
    why: "S&P 500 月度市盈率、资料来源和最近更新月份",
  },
  {
    id: "eastmoney-spy",
    label: "东方财富 SPY 实时行情",
    url: "https://quote.eastmoney.com/us/SPY.html",
    why: "标普500 ETF 最新价格、涨跌幅和行情新闻",
  },
  {
    id: "eastmoney-bond-news",
    label: "东方财富债券频道",
    url: "https://bond.eastmoney.com/",
    why: "债券市场最新新闻、美国10年期国债收益率新闻和风险偏好线索",
  },
  {
    id: "wallstreetcn-global",
    label: "华尔街见闻全球市场",
    url: "https://wallstreetcn.com/news/global",
    why: "中文市场快讯、宏观政策和全球资产新闻",
  },
];

function sendFile(res, filePath) {
  fs.readFile(filePath, (error, content) => {
    if (error) {
      res.writeHead(error.code === "ENOENT" ? 404 : 500, {
        "Content-Type": "text/plain; charset=utf-8",
      });
      res.end(error.code === "ENOENT" ? "404 Not Found" : "500 Server Error");
      return;
    }

    const extension = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": mimeTypes[extension] || "application/octet-stream",
      "Cache-Control": "no-store",
    });
    res.end(content);
  });
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(payload));
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJsonFile(filePath, payload) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
}

function requestText(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const client = target.protocol === "http:" ? http : https;
    const request = client.request(
      target,
      {
        method: "GET",
        headers: {
          "User-Agent": "Mozilla/5.0 AllWeather.Fix/1.0",
          Accept: "text/plain,text/markdown,text/html,application/json",
        },
        timeout,
      },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          body += chunk;
          if (body.length > 1024 * 1024 * 2) request.destroy(new Error("市场信息内容过大"));
        });
        response.on("end", () => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }
          resolve(body);
        });
      }
    );

    request.on("timeout", () => request.destroy(new Error("请求超时")));
    request.on("error", reject);
    request.end();
  });
}

function requestTextWithPowerShell(url, timeout = 60000) {
  const script = [
    "$ProgressPreference = 'SilentlyContinue'",
    "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8",
    `$response = Invoke-WebRequest -Uri ${JSON.stringify(url)} -UseBasicParsing -TimeoutSec ${Math.ceil(timeout / 1000)}`,
    "$response.Content",
  ].join("; ");

  return new Promise((resolve, reject) => {
    execFile(
      "powershell",
      ["-NoProfile", "-Command", script],
      { timeout: timeout + 5000, maxBuffer: 1024 * 1024 * 3, encoding: "utf8" },
      (error, stdout, stderr) => {
        if (error) {
          reject(new Error(stderr.trim() || error.message));
          return;
        }
        resolve(stdout);
      }
    );
  });
}

function compactSourceText(text, maxLength = 4200) {
  return String(text || "")
    .replace(/\r/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .slice(0, maxLength)
    .trim();
}

function extractSourceDates(text, now = new Date()) {
  const dates = [];
  const content = String(text || "");
  const currentYear = now.getFullYear();
  const latestAllowed = new Date(currentYear, now.getMonth(), now.getDate() + 2);

  function pushDate(year, month, day) {
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (
      date.getFullYear() !== Number(year) ||
      date.getMonth() !== Number(month) - 1 ||
      date.getDate() !== Number(day) ||
      date > latestAllowed ||
      date.getFullYear() < currentYear - 2
    ) {
      return;
    }
    dates.push(date);
  }

  for (const match of content.matchAll(/\b(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?\b/g)) {
    pushDate(match[1], match[2], match[3]);
  }

  for (const match of content.matchAll(/(?:Published|Updated|发布时间|更新时间|日期)[:：\s]*(20\d{2})[-/.年](\d{1,2})[-/.月](\d{1,2})日?/gi)) {
    pushDate(match[1], match[2], match[3]);
  }

  for (const match of content.matchAll(/(?<!\d)(\d{1,2})月(\d{1,2})日(?!\d)/g)) {
    let year = currentYear;
    let date = new Date(year, Number(match[1]) - 1, Number(match[2]));
    if (date > latestAllowed) {
      year -= 1;
      date = new Date(year, Number(match[1]) - 1, Number(match[2]));
    }
    pushDate(year, match[1], match[2]);
  }

  return dates.sort((a, b) => b - a);
}

function getSourceFreshness(text, now = new Date()) {
  const [latestDate] = extractSourceDates(text, now);
  if (!latestDate) {
    return {
      status: "unknown",
      label: "未知日期",
      latestDate: null,
      ageDays: null,
    };
  }

  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dateOnly = new Date(latestDate.getFullYear(), latestDate.getMonth(), latestDate.getDate());
  const ageDays = Math.max(0, Math.round((today - dateOnly) / (1000 * 60 * 60 * 24)));
  if (ageDays <= 14) return { status: "fresh", label: "最新", latestDate, ageDays };
  if (ageDays <= 30) return { status: "recent", label: "近期", latestDate, ageDays };
  if (ageDays <= 90) return { status: "dated", label: "偏旧", latestDate, ageDays };
  return { status: "stale", label: "过时", latestDate, ageDays };
}

async function fetchMarketSource(source) {
  const readerUrl = `https://r.jina.ai/http://${source.url.replace(/^https?:\/\//, "")}`;
  let text = "";
  try {
    text = await requestText(readerUrl, 18000);
  } catch {
    text = await requestTextWithPowerShell(readerUrl, 60000);
  }
  const compactText = compactSourceText(text);
  const freshness = getSourceFreshness(compactText);
  return {
    ...source,
    fetchedAt: new Date().toISOString(),
    text: compactText,
    freshness: freshness.status,
    freshnessLabel: freshness.label,
    latestDate: freshness.latestDate ? freshness.latestDate.toISOString().slice(0, 10) : null,
    ageDays: freshness.ageDays,
  };
}

async function getMarketContext() {
  if (marketContextCache && Date.now() - marketContextCacheTime < MARKET_CONTEXT_CACHE_TTL) {
    return marketContextCache;
  }

  const settled = await Promise.allSettled(marketSources.map(fetchMarketSource));
  const sources = settled.map((result, index) => {
    const source = marketSources[index];
    if (result.status === "fulfilled") return result.value;
    return {
      ...source,
      fetchedAt: new Date().toISOString(),
      error: result.reason?.message || "获取失败",
      text: "",
      freshness: "unknown",
      freshnessLabel: "未知日期",
      latestDate: null,
      ageDays: null,
    };
  });

  const usableSources = sources.filter((source) => source.text);
  const freshSources = usableSources.filter((source) => source.freshness === "fresh" || source.freshness === "recent");
  const staleSources = usableSources.filter((source) => source.freshness === "dated" || source.freshness === "stale" || source.freshness === "unknown");
  const warnings = [];
  if (usableSources.length < marketSources.length) {
    warnings.push("部分市场信息源暂时不可达；模型应明确标注缺失来源，并降低结论置信度。");
  }
  if (freshSources.length === 0 && usableSources.length > 0) {
    warnings.push("可用市场信息源没有最近 30 天内的有效日期；模型不得给出高置信度调仓结论。");
  } else if (staleSources.length > 0) {
    warnings.push("部分市场信息源日期偏旧或未知；这些内容只能作为背景，不可单独支撑强调仓结论。");
  }
  marketContextCache = {
    generatedAt: new Date().toISOString(),
    sourceCount: usableSources.length,
    freshSourceCount: freshSources.length,
    warning: warnings.join(" "),
    sources,
    promptText: usableSources
      .map(
        (source) => `【${source.label}】\n用途：${source.why}\n来源：${source.url}\n抓取时间：${source.fetchedAt}\n信息新鲜度：${source.freshnessLabel}${source.latestDate ? `，最近日期 ${source.latestDate}，距今 ${source.ageDays} 天` : "，未识别到有效日期"}\n使用规则：${source.freshness === "fresh" || source.freshness === "recent" ? "可作为当前判断依据，但仍需与其他来源交叉验证" : "只能作为背景材料，不可单独支撑策略调整"}\n摘录：\n${source.text}`
      )
      .join("\n\n---\n\n"),
  };
  marketContextCacheTime = Date.now();
  return marketContextCache;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 1024 * 1024) {
        req.destroy(new Error("请求体过大"));
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(new Error("请求 JSON 解析失败"));
      }
    });
    req.on("error", reject);
  });
}

function requestAiProvider({ baseUrl, apiKey, protocol, model, prompt }) {
  const normalizedBaseUrl = String(baseUrl || "").replace(/\/+$/, "");
  const endpoint = protocol === "responses" ? "/responses" : "/chat/completions";
  const target = new URL(`${normalizedBaseUrl}${endpoint}`);
  const client = target.protocol === "http:" ? http : https;
  const payload =
    protocol === "responses"
      ? {
          model,
          input: prompt,
          temperature: 0.3,
        }
      : {
          model,
          messages: [{ role: "user", content: prompt }],
          temperature: 0.3,
        };
  const body = JSON.stringify(payload);

  return new Promise((resolve, reject) => {
    const request = client.request(
      target,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
        timeout: 90000,
      },
      (response) => {
        let responseBody = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => {
          responseBody += chunk;
        });
        response.on("end", () => {
          let parsed = null;
          try {
            parsed = JSON.parse(responseBody);
          } catch {
            parsed = { raw: responseBody };
          }

          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(parsed?.error?.message || parsed?.message || `AI 接口返回 HTTP ${response.statusCode}`));
            return;
          }

          const text =
            protocol === "responses"
              ? parsed.output_text ||
                parsed.output
                  ?.flatMap((item) => item.content || [])
                  .map((content) => content.text || "")
                  .join("\n")
                  .trim()
              : parsed.choices?.[0]?.message?.content;

          if (!text) {
            reject(new Error("AI 接口没有返回可显示的文本"));
            return;
          }

          resolve({ text, raw: parsed });
        });
      }
    );

    request.on("timeout", () => {
      request.destroy(new Error("AI 接口请求超时"));
    });
    request.on("error", reject);
    request.write(body);
    request.end();
  });
}

function validateAiConfig(payload) {
  const baseUrl = String(payload.baseUrl || "").trim();
  const apiKey = String(payload.apiKey || "").trim();
  const protocol = ["chat", "responses"].includes(payload.protocol) ? payload.protocol : "chat";
  const model = String(payload.model || "").trim();
  const prompt = String(payload.prompt || "").trim();

  if (!baseUrl) throw new Error("请填写 API 基础地址");
  if (!/^https?:\/\//i.test(baseUrl)) throw new Error("API 基础地址必须以 http:// 或 https:// 开头");
  if (!apiKey) throw new Error("请填写 API Key");
  if (!model) throw new Error("请填写模型名称");
  if (!prompt) throw new Error("分析提示词为空");

  return { baseUrl, apiKey, protocol, model, prompt };
}

function fetchYahooMonthlyPrices(tickers) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_COMMAND, [YAHOO_FETCH_SCRIPT, ...tickers], { timeout: 60000, maxBuffer: 1024 * 1024 * 16 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`历史行情 JSON 解析失败：${parseError.message}`));
      }
    });
  });
}

function fetchYahooDailyCandles(ticker) {
  return new Promise((resolve, reject) => {
    execFile(PYTHON_COMMAND, [YAHOO_CANDLE_SCRIPT, ticker], { timeout: 90000, maxBuffer: 1024 * 1024 * 32 }, (error, stdout, stderr) => {
      if (error) {
        reject(new Error(stderr.trim() || error.message));
        return;
      }

      try {
        resolve(JSON.parse(stdout));
      } catch (parseError) {
        reject(new Error(`K线 JSON 解析失败：${parseError.message}`));
      }
    });
  });
}

function getIsoWeekKey(date) {
  const utc = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = utc.getUTCDay() || 7;
  utc.setUTCDate(utc.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(utc.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((utc - yearStart) / 86400000 + 1) / 7);
  return `${utc.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function getCandlePeriodKey(dateString, timeframe) {
  const date = new Date(`${dateString}T00:00:00Z`);
  if (timeframe === "1w") return getIsoWeekKey(date);
  if (timeframe === "1mo") return dateString.slice(0, 7);
  if (timeframe === "1y") return dateString.slice(0, 4);
  return dateString;
}

function aggregateCandles(candles, timeframe) {
  if (timeframe === "1d") return candles;

  const grouped = new Map();
  candles.forEach((candle) => {
    const key = getCandlePeriodKey(candle.date, timeframe);
    const group = grouped.get(key);
    if (!group) {
      grouped.set(key, { ...candle, period: key });
      return;
    }

    group.high = Math.max(group.high, candle.high);
    group.low = Math.min(group.low, candle.low);
    group.close = candle.close;
    group.adjClose = candle.adjClose;
    group.volume += candle.volume;
    group.date = candle.date;
  });

  return [...grouped.values()];
}

async function getCandles(assetId, timeframe) {
  const asset = backtestSymbols[assetId];
  if (!asset) throw new Error("未知资产");

  const safeTimeframe = ["1d", "1w", "1mo", "1y"].includes(timeframe) ? timeframe : "1mo";
  const localCandleFile = path.join(CANDLE_DATA_DIR, `${assetId}-${safeTimeframe}.json`);
  const localPayload = readJsonFile(localCandleFile);
  if (localPayload?.candles?.length) {
    return {
      ...localPayload,
      loadedFrom: "local-file",
    };
  }

  const cacheKey = `${asset.ticker}:${safeTimeframe}`;
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.time < CANDLE_CACHE_TTL) {
    return cached.payload;
  }

  const dailyKey = `${asset.ticker}:1d:raw`;
  let dailyPayload = candleCache.get(dailyKey);
  if (!dailyPayload || Date.now() - dailyPayload.time >= CANDLE_CACHE_TTL) {
    dailyPayload = {
      time: Date.now(),
      payload: await fetchYahooDailyCandles(asset.ticker),
    };
    candleCache.set(dailyKey, dailyPayload);
  }

  const candles = aggregateCandles(dailyPayload.payload.candles, safeTimeframe);
  const payload = {
    generatedAt: new Date().toISOString(),
    assetId,
    name: asset.name,
    ticker: asset.ticker,
    proxy: asset.proxy,
    timeframe: safeTimeframe,
    startDate: candles[0]?.date,
    endDate: candles[candles.length - 1]?.date,
    sources: `Yahoo Finance ${asset.ticker} OHLC 历史价格`,
    disclaimer: "K线使用公开 ETF 代理历史 OHLC，未复权显示价格，不含税费、滑点和汇率影响。",
    candles,
  };

  writeJsonFile(localCandleFile, payload);
  candleCache.set(cacheKey, { time: Date.now(), payload });
  return payload;
}

function getCommonMonthRange(assetEntries) {
  const commonMonths = assetEntries
    .map(([, asset]) => new Set(asset.prices.map((price) => price.date.slice(0, 7))))
    .reduce((common, months) => new Set([...common].filter((month) => months.has(month))));

  const sortedMonths = [...commonMonths].sort();
  return {
    startMonth: sortedMonths[0],
    endMonth: sortedMonths[sortedMonths.length - 1],
    monthCount: sortedMonths.length,
    months: new Set(sortedMonths),
  };
}

async function getBacktestPrices() {
  const localPayload = readJsonFile(BACKTEST_DATA_FILE);
  if (localPayload?.assets) {
    return {
      ...localPayload,
      loadedFrom: "local-file",
    };
  }

  if (backtestCache && Date.now() - backtestCacheTime < BACKTEST_CACHE_TTL) {
    return backtestCache;
  }

  const tickers = Object.values(backtestSymbols).map((asset) => asset.ticker);
  const yahooPrices = await fetchYahooMonthlyPrices(tickers);
  const entries = Object.entries(backtestSymbols).map(([assetId, asset]) => [
      assetId,
      {
        name: asset.name,
        ticker: asset.ticker,
        proxy: asset.proxy,
        source: `Yahoo Finance ${asset.ticker} 月度 Adjusted Close`,
        prices: yahooPrices[asset.ticker],
      },
    ]);
  const commonRange = getCommonMonthRange(entries);

  if (!commonRange.monthCount) {
    throw new Error("四类资产没有共同可回测月份");
  }

  backtestCache = {
    generatedAt: new Date().toISOString(),
    startDate: `${commonRange.startMonth}-01`,
    endDate: `${commonRange.endMonth}-01`,
    monthCount: commonRange.monthCount,
    frequency: "monthly",
    sources: "Yahoo Finance 月度 Adjusted Close；ETF 代理：SPY、QQQ、TLT、GLD",
    disclaimer: "该回测使用公开 ETF 代理历史价格，不含税费、滑点、申赎成本和汇率影响；结果不构成投资建议。",
    assets: Object.fromEntries(
      entries.map(([assetId, asset]) => [
        assetId,
        {
          ...asset,
          prices: asset.prices.filter((price) => commonRange.months.has(price.date.slice(0, 7))),
        },
      ])
    ),
  };
  backtestCacheTime = Date.now();
  writeJsonFile(BACKTEST_DATA_FILE, backtestCache);
  return backtestCache;
}

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);

  if (pathname === "/api/backtest-prices") {
    try {
      const prices = await getBacktestPrices();
      sendJson(res, 200, prices);
    } catch (error) {
      sendJson(res, 502, {
        error: "历史行情暂时获取失败",
        detail: error.message,
      });
    }
    return;
  }

  if (pathname === "/api/candles") {
    try {
      const assetId = requestUrl.searchParams.get("asset") || "sp500";
      const timeframe = requestUrl.searchParams.get("timeframe") || "1mo";
      const candles = await getCandles(assetId, timeframe);
      sendJson(res, 200, candles);
    } catch (error) {
      sendJson(res, 502, {
        error: "K线行情暂时获取失败",
        detail: error.message,
      });
    }
    return;
  }

  if (pathname === "/api/market-context") {
    try {
      const context = await getMarketContext();
      sendJson(res, 200, context);
    } catch (error) {
      sendJson(res, 502, {
        error: "市场上下文暂时获取失败",
        detail: error.message,
      });
    }
    return;
  }

  if (pathname === "/api/ai-analysis" && req.method === "POST") {
    try {
      const payload = await readJsonBody(req);
      const config = validateAiConfig(payload);
      const analysis = await requestAiProvider(config);
      sendJson(res, 200, { text: analysis.text });
    } catch (error) {
      sendJson(res, 502, {
        error: "AI 分析暂时失败",
        detail: error.message,
      });
    }
    return;
  }

  const relativePath = pathname === "/" ? "index.html" : pathname.slice(1);
  const resolvedPath = path.resolve(ROOT, relativePath);

  if (resolvedPath !== ROOT && !resolvedPath.startsWith(ROOT_WITH_SEPARATOR)) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("403 Forbidden");
    return;
  }

  sendFile(res, resolvedPath);
});

server.listen(PORT, () => {
  console.log(`AllWeather.Fix is running at http://localhost:${PORT}`);
});
