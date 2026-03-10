import type { Express } from "express";
import { createServer, type Server } from "http";
import { storage } from "./storage";
import Groq from "groq-sdk";
import OpenAI from "openai";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import Parser from "rss-parser";
import { COMPANY_TO_SECTOR } from "../client/src/lib/sectors.js";
import { extractCountries } from "./country-extractor.js";

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const rssParser = new Parser({
  customFields: {
    item: [
      ["media:content", "media:content", { keepArray: false }],
      ["media:thumbnail", "media:thumbnail", { keepArray: false }],
    ],
  },
});

const QUERY_GROUPS = [
  'inflation OR CPI OR PCE OR unemployment OR payrolls OR GDP OR PMI',
  'Fed OR FOMC OR "interest rate" OR "rate cut" OR "rate hike" OR "central bank" OR ECB OR BoJ',
  '"bond yields" OR Treasuries OR "credit spreads" OR VIX OR "equity selloff"',
  'oil OR OPEC OR Brent OR WTI OR LNG OR "commodity prices"',
  'geopolitics OR sanctions OR tariffs OR "export controls" OR regulation',
  'China OR yuan OR "property sector" OR stimulus OR "emerging markets"',
];

const RSS_FEEDS = [
  { url: "https://feeds.bbci.co.uk/news/business/rss.xml", source: "BBC Business" },
  { url: "https://rss.nytimes.com/services/xml/rss/nyt/Economy.xml", source: "NYT Economy" },
  { url: "https://www.reuters.com/rssFeed/businessNews", source: "Reuters" },
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", source: "CNBC" },
  { url: "https://www.marketwatch.com/rss/topstories", source: "MarketWatch" },
];

const EXCLUSIONS = ["-sports", "-celebrity", "-recipe", "-horoscope"];

const NOISE_WORDS = [
  "horoscope", "zodiac", "astrology",
  "recipe", "cooking", "baking",
  "celebrity", "kardashian", "hollywood",
  "sports score", "nfl", "nba", "mlb", "premier league",
  "wordle", "crossword", "puzzle",
];

interface NewsArticle {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  description: string;
  imageUrl?: string;
}

type Region = "US" | "EU" | "China" | "APAC" | "Global" | "Other";

interface ClassifiedArticle extends NewsArticle {
  theme: string;
  emerging_label?: string;
  region: Region;
}

const REGION_PATTERNS: [RegExp, Region][] = [
  [/\b(china|chinese|beijing|shanghai|xi jinping|yuan|renminbi|pboc|hong kong)\b/i, "China"],
  [/\b(us |u\.s\.|united states|america|washington|wall street|fed |federal reserve|fomc|treasury|congress|white house|dollar|nasdaq|s&p|dow jones)\b/i, "US"],
  [/\b(euro|europe|eu |ecb|eurozone|germany|france|italy|spain|uk |britain|british|bank of england|boe|brussels|london)\b/i, "EU"],
  [/\b(japan|japanese|boj|bank of japan|yen|nikkei|tokyo|india|indian|modi|rupee|australia|rba|korea|korean|asean|southeast asia|taiwan|tsmc|singapore)\b/i, "APAC"],
  [/\b(global|world|international|imf|world bank|g7|g20|oecd|emerging market|developing econom)\b/i, "Global"],
];

function detectRegion(title: string, description: string): Region {
  const text = `${title} ${description}`;
  for (const [pattern, region] of REGION_PATTERNS) {
    if (pattern.test(text)) return region;
  }
  return "Other";
}

interface ThemeDebugCounts {
  count3d: number;
  avgDaily14d: number;
}

interface ThemeHistorySnapshot {
  date: string;
  score: number;
  heat: "hot" | "warm" | "cool";
  count3d: number;
  avgDaily14d: number;
}

type ThemeHistory = Record<string, ThemeHistorySnapshot[]>;

interface TimeseriesPoint {
  date: string;
  count: number;
}

interface HistoricalEvent {
  year: string;
  name: string;
  description: string;
  drivers: string[];
  macroOutcomes: string[];
  marketImpact: string[];
  embedding?: number[];
}

async function getEmbedding(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: "text-embedding-3-small",
    input: text
  });
  return response.data[0].embedding;
}

function cosineSimilarity(a: number[], b: number[]): number {
  const dot = a.reduce((sum, val, i) => sum + val * b[i], 0);
  const magA = Math.sqrt(a.reduce((sum, val) => sum + val * val, 0));
  const magB = Math.sqrt(b.reduce((sum, val) => sum + val * val, 0));
  return dot / (magA * magB);
}

function macroFeatureMatch(noteKeywords: string[], event: HistoricalEvent): number {
  const allFeatures = [...event.drivers, ...event.macroOutcomes, ...event.marketImpact];
  const matches = noteKeywords.filter(kw =>
    allFeatures.some(f => f.includes(kw) || kw.includes(f))
  ).length;
  return matches / Math.max(noteKeywords.length, 1);
}

function marketImpactSimilarity(noteKeywords: string[], event: HistoricalEvent): number {
  const matches = noteKeywords.filter(kw =>
    event.marketImpact.some(impact => impact.includes(kw) || kw.includes(impact))
  ).length;
  return matches / Math.max(noteKeywords.length, 1);
}

type AssetClass = "Rates" | "Equities" | "FX" | "Commodities" | "Credit";
type AssetImpactLevel = "High" | "Medium" | "Low";

interface AssetImpact {
  asset: AssetClass;
  level: AssetImpactLevel;
  marketMove?: number;
}

interface RelatedTheme {
  name: string;
  strength: number;
}

interface InstitutionalSource {
  source: string;
  title: string;
  snippet: string;
  url?: string;
}

interface ThemeGroup {
  id: string;
  name: string;
  heat: "hot" | "warm" | "cool";
  score: number;
  trend: "up" | "down" | "flat";
  articles: ClassifiedArticle[];
  isEmerging: boolean;
  emerging_label?: string;
  debugCounts?: ThemeDebugCounts;
  timeseries: TimeseriesPoint[];
  milestones: string[];
  assetImpacts: AssetImpact[];
  relatedThemes: RelatedTheme[];
  articlesByDate: Record<string, ClassifiedArticle[]>;
  institutionalLens?: InstitutionalSource[];
  corporateSignals?: number;
}

interface EarningsEvent {
  company: string;
  symbol: string;
  date: string;
  sector: string;
}

interface CorporateSignal {
  company: string;
  ticker: string;
  articleTitle: string;
  sector: string;
  signalSentiment: "positive" | "neutral" | "negative";
  timestamp: string;
}

const TOP_COMPANIES = [
  // Technology
  { name: "Apple", symbol: "AAPL", sector: "Technology" },
  { name: "Microsoft", symbol: "MSFT", sector: "Technology" },
  { name: "Nvidia", symbol: "NVDA", sector: "Technology" },
  { name: "Meta", symbol: "META", sector: "Technology" },
  { name: "Alphabet", symbol: "GOOGL", sector: "Technology" },
  { name: "Google", symbol: "GOOGL", sector: "Technology" },
  { name: "Oracle", symbol: "ORCL", sector: "Technology" },
  { name: "Salesforce", symbol: "CRM", sector: "Technology" },
  { name: "Adobe", symbol: "ADBE", sector: "Technology" },
  { name: "Alibaba", symbol: "BABA", sector: "Technology" },
  { name: "Baidu", symbol: "BIDU", sector: "Technology" },
  { name: "Intel", symbol: "INTC", sector: "Technology" },
  { name: "AMD", symbol: "AMD", sector: "Technology" },
  { name: "IBM", symbol: "IBM", sector: "Technology" },
  { name: "Cisco", symbol: "CSCO", sector: "Technology" },
  { name: "Qualcomm", symbol: "QCOM", sector: "Technology" },
  { name: "Broadcom", symbol: "AVGO", sector: "Technology" },
  { name: "ASML", symbol: "ASML", sector: "Technology" },
  { name: "SAP", symbol: "SAP", sector: "Technology" },
  { name: "Tencent", symbol: "TCEHY", sector: "Technology" },
  { name: "Samsung", symbol: "SSNLF", sector: "Technology" },
  { name: "TSMC", symbol: "TSM", sector: "Technology" },
  { name: "Netflix", symbol: "NFLX", sector: "Technology" },
  { name: "Spotify", symbol: "SPOT", sector: "Technology" },
  { name: "Uber", symbol: "UBER", sector: "Technology" },
  { name: "Airbnb", symbol: "ABNB", sector: "Technology" },
  { name: "Palantir", symbol: "PLTR", sector: "Technology" },
  { name: "Snowflake", symbol: "SNOW", sector: "Technology" },
  // Financials
  { name: "JPMorgan Chase", symbol: "JPM", sector: "Financials" },
  { name: "JPMorgan", symbol: "JPM", sector: "Financials" },
  { name: "Bank of America", symbol: "BAC", sector: "Financials" },
  { name: "Wells Fargo", symbol: "WFC", sector: "Financials" },
  { name: "Citigroup", symbol: "C", sector: "Financials" },
  { name: "Goldman Sachs", symbol: "GS", sector: "Financials" },
  { name: "Morgan Stanley", symbol: "MS", sector: "Financials" },
  { name: "BlackRock", symbol: "BLK", sector: "Financials" },
  { name: "Charles Schwab", symbol: "SCHW", sector: "Financials" },
  { name: "American Express", symbol: "AXP", sector: "Financials" },
  { name: "Visa", symbol: "V", sector: "Financials" },
  { name: "Mastercard", symbol: "MA", sector: "Financials" },
  { name: "PayPal", symbol: "PYPL", sector: "Financials" },
  { name: "Square", symbol: "SQ", sector: "Financials" },
  { name: "Coinbase", symbol: "COIN", sector: "Financials" },
  // Energy
  { name: "Exxon Mobil", symbol: "XOM", sector: "Energy" },
  { name: "Exxon", symbol: "XOM", sector: "Energy" },
  { name: "Chevron", symbol: "CVX", sector: "Energy" },
  { name: "ConocoPhillips", symbol: "COP", sector: "Energy" },
  { name: "Schlumberger", symbol: "SLB", sector: "Energy" },
  { name: "Shell", symbol: "SHEL", sector: "Energy" },
  { name: "BP", symbol: "BP", sector: "Energy" },
  { name: "TotalEnergies", symbol: "TTE", sector: "Energy" },
  { name: "Occidental", symbol: "OXY", sector: "Energy" },
  // Consumer Discretionary
  { name: "Amazon", symbol: "AMZN", sector: "Consumer Discretionary" },
  { name: "Tesla", symbol: "TSLA", sector: "Consumer Discretionary" },
  { name: "Home Depot", symbol: "HD", sector: "Consumer Discretionary" },
  { name: "McDonald's", symbol: "MCD", sector: "Consumer Discretionary" },
  { name: "Nike", symbol: "NKE", sector: "Consumer Discretionary" },
  { name: "Starbucks", symbol: "SBUX", sector: "Consumer Discretionary" },
  { name: "JD.com", symbol: "JD", sector: "Consumer Discretionary" },
  { name: "NIO", symbol: "NIO", sector: "Consumer Discretionary" },
  { name: "Ford", symbol: "F", sector: "Consumer Discretionary" },
  { name: "General Motors", symbol: "GM", sector: "Consumer Discretionary" },
  { name: "GM", symbol: "GM", sector: "Consumer Discretionary" },
  { name: "Toyota", symbol: "TM", sector: "Consumer Discretionary" },
  { name: "Volkswagen", symbol: "VWAGY", sector: "Consumer Discretionary" },
  { name: "Target", symbol: "TGT", sector: "Consumer Discretionary" },
  { name: "Lowe's", symbol: "LOW", sector: "Consumer Discretionary" },
  { name: "TJX", symbol: "TJX", sector: "Consumer Discretionary" },
  { name: "Booking", symbol: "BKNG", sector: "Consumer Discretionary" },
  { name: "Marriott", symbol: "MAR", sector: "Consumer Discretionary" },
  // Consumer Staples
  { name: "Walmart", symbol: "WMT", sector: "Consumer Staples" },
  { name: "Procter & Gamble", symbol: "PG", sector: "Consumer Staples" },
  { name: "Coca-Cola", symbol: "KO", sector: "Consumer Staples" },
  { name: "PepsiCo", symbol: "PEP", sector: "Consumer Staples" },
  { name: "Costco", symbol: "COST", sector: "Consumer Staples" },
  { name: "Unilever", symbol: "UL", sector: "Consumer Staples" },
  { name: "Nestle", symbol: "NSRGY", sector: "Consumer Staples" },
  { name: "Mondelez", symbol: "MDLZ", sector: "Consumer Staples" },
  // Industrials
  { name: "Caterpillar", symbol: "CAT", sector: "Industrials" },
  { name: "Boeing", symbol: "BA", sector: "Industrials" },
  { name: "FedEx", symbol: "FDX", sector: "Industrials" },
  { name: "UPS", symbol: "UPS", sector: "Industrials" },
  { name: "Deere", symbol: "DE", sector: "Industrials" },
  { name: "Lockheed Martin", symbol: "LMT", sector: "Industrials" },
  { name: "Raytheon", symbol: "RTX", sector: "Industrials" },
  { name: "Northrop Grumman", symbol: "NOC", sector: "Industrials" },
  { name: "General Dynamics", symbol: "GD", sector: "Industrials" },
  { name: "Honeywell", symbol: "HON", sector: "Industrials" },
  { name: "3M", symbol: "MMM", sector: "Industrials" },
  { name: "General Electric", symbol: "GE", sector: "Industrials" },
  { name: "GE", symbol: "GE", sector: "Industrials" },
  { name: "Siemens", symbol: "SIEGY", sector: "Industrials" },
  // Healthcare
  { name: "UnitedHealth", symbol: "UNH", sector: "Healthcare" },
  { name: "Johnson & Johnson", symbol: "JNJ", sector: "Healthcare" },
  { name: "Pfizer", symbol: "PFE", sector: "Healthcare" },
  { name: "Merck", symbol: "MRK", sector: "Healthcare" },
  { name: "AbbVie", symbol: "ABBV", sector: "Healthcare" },
  { name: "Eli Lilly", symbol: "LLY", sector: "Healthcare" },
  { name: "Novo Nordisk", symbol: "NVO", sector: "Healthcare" },
  { name: "Bristol Myers", symbol: "BMY", sector: "Healthcare" },
  { name: "AstraZeneca", symbol: "AZN", sector: "Healthcare" },
  { name: "Moderna", symbol: "MRNA", sector: "Healthcare" },
  // Materials
  { name: "Freeport-McMoRan", symbol: "FCX", sector: "Materials" },
  { name: "Newmont", symbol: "NEM", sector: "Materials" },
  { name: "BHP", symbol: "BHP", sector: "Materials" },
  { name: "Rio Tinto", symbol: "RIO", sector: "Materials" },
  // Utilities
  { name: "NextEra Energy", symbol: "NEE", sector: "Utilities" },
  { name: "Duke Energy", symbol: "DUK", sector: "Utilities" },
  // Real Estate
  { name: "American Tower", symbol: "AMT", sector: "Real Estate" },
  { name: "Prologis", symbol: "PLD", sector: "Real Estate" },
  // Business Services
  { name: "ADP", symbol: "ADP", sector: "Business Services" },
  { name: "Paychex", symbol: "PAYX", sector: "Business Services" },
];

const EARNINGS_KEYWORDS = [
  "earnings", "quarterly results", "guidance", "earnings call", "profit forecast", "revenue outlook",
  "beats expectations", "misses estimates", "q1", "q2", "q3", "q4", "quarter", "fiscal year",
  "revenue", "profit", "sales", "margin", "eps", "dividend", "buyback", "share repurchase",
  "acquisition", "merger", "deal", "partnership", "investment", "expansion", "layoffs", "restructuring",
  "ceo", "executive", "leadership", "announces", "reports", "posts", "delivers", "forecast",
  "outlook", "target", "projection", "estimate", "analyst", "stock", "shares"
];

const RISK_TAG_TO_ASSET: Record<string, AssetClass[]> = {
  // MONETARY POLICY / RATES
  "Monetary Policy": ["Rates"],
  "Central Banks": ["Rates"],
  "Global Monetary Policy": ["Rates"],
  "Interest Rates": ["Rates"],
  "Rate Hikes": ["Rates"],
  "Rate Cuts": ["Rates"],
  "Yield Curve": ["Rates"],
  "Yield Curve Inversion": ["Rates"],
  "Duration": ["Rates"],
  "Duration Risk": ["Rates"],
  "Rate Differential": ["Rates"],
  "Bond Yields": ["Rates"],
  "Treasuries": ["Rates"],
  "Quantitative Tightening": ["Rates"],
  "Quantitative Easing": ["Rates"],
  "Liquidity": ["Rates", "Credit"],
  "Sovereign Risk": ["Rates"],
  "Fiscal Deficit": ["Rates"],

  // INFLATION / MACRO PRICES
  "Inflation": ["Rates", "Commodities"],
  "Disinflation": ["Rates"],
  "Consumer Prices": ["Rates", "Equities"],
  "Producer Prices": ["Commodities"],
  "Inflation Expectations": ["Rates"],
  "Inflation Pass-Through": ["Commodities"],
  "Energy Inflation": ["Commodities", "Rates"],
  "Food Inflation": ["Commodities"],

  // ECONOMIC GROWTH
  "Recession": ["Equities", "Credit"],
  "Economic Slowdown": ["Equities"],
  "Growth": ["Equities"],
  "GDP": ["Equities"],
  "Productivity": ["Equities"],
  "Manufacturing": ["Equities", "Commodities"],
  "Industrial Production": ["Equities", "Commodities"],
  "Business Investment": ["Equities"],

  // LABOR MARKET
  "Labor Market": ["Equities"],
  "Unemployment": ["Equities"],
  "Wages": ["Equities", "Rates"],
  "Employment": ["Equities"],

  // CONSUMER
  "Consumer Spending": ["Equities"],
  "Consumer Confidence": ["Equities"],
  "Retail Sales": ["Equities"],
  "Household Debt": ["Credit", "Equities"],

  // FINANCIAL SYSTEM
  "Banking": ["Equities", "Credit"],
  "Banking Crisis": ["Credit", "Equities"],
  "Financial Stability": ["Credit"],
  "Financial Stress": ["Credit"],
  "Credit Risk": ["Credit"],
  "Credit Spreads": ["Credit"],
  "Corporate Debt": ["Credit"],
  "Defaults": ["Credit"],

  // FX / CURRENCY
  "USD Strength": ["FX"],
  "Dollar Liquidity": ["FX"],
  "Currency": ["FX"],
  "Currency Volatility": ["FX"],
  "FX Intervention": ["FX"],
  "Exchange Rate": ["FX"],
  "Devaluation": ["FX"],

  // EMERGING MARKETS
  "EM Risk": ["FX", "Credit"],
  "EM Contagion": ["FX", "Credit"],
  "Capital Flows": ["FX"],
  "Capital Flight": ["FX"],
  "Debt Crisis": ["Credit", "FX"],

  // COMMODITIES
  "Commodities": ["Commodities"],
  "Commodity Demand": ["Commodities"],
  "Commodity Supply": ["Commodities"],
  "Supply Disruption": ["Commodities"],
  "Energy Sector": ["Commodities", "Equities"],
  "Oil Prices": ["Commodities", "FX"],
  "Gas Prices": ["Commodities"],
  "Metals": ["Commodities"],
  "Agriculture": ["Commodities"],

  // ENERGY
  "Energy Shock": ["Commodities", "Rates"],
  "Energy Supply": ["Commodities"],
  "Energy Demand": ["Commodities"],
  "OPEC": ["Commodities", "FX"],

  // GEOPOLITICS
  "Geopolitics": ["FX", "Commodities"],
  "War": ["FX", "Commodities"],
  "Conflict": ["FX", "Commodities"],
  "Sanctions": ["FX", "Commodities", "Equities"],
  "Defense": ["Equities"],
  "Political Risk": ["FX"],

  // TRADE
  "Trade War": ["FX", "Equities"],
  "Trade Policy": ["Equities"],
  "Tariffs": ["Equities", "FX"],
  "Supply Chain": ["Equities", "Commodities"],
  "Global Trade": ["Equities", "FX"],
  "Exports": ["Equities", "FX"],
  "Imports": ["Equities"],

  // REGULATION
  "Regulation": ["Equities"],
  "Compliance": ["Credit"],
  "Financial Regulation": ["Equities", "Credit"],
  "Antitrust": ["Equities"],

  // TECHNOLOGY / STRUCTURAL
  "Technology": ["Equities"],
  "AI Industry": ["Equities"],
  "Semiconductors": ["Equities"],
  "Cybersecurity": ["Equities"],

  // LEGACY MAPPINGS (for backward compatibility)
  "Rates": ["Rates"],
  "Equities": ["Equities"],
  "FX": ["FX"],
  "Credit": ["Credit"],
  "Fintech": ["Equities"],
  "EM Rates": ["Rates"],
  "Transport": ["Commodities"],
  "Commodities Demand": ["Commodities"],
  "Commodity Risk": ["Commodities"],
};

const RISK_TAG_WEIGHTS: Record<string, number> = {
  "Rates": 3, "Duration Risk": 2, "Duration": 2, "Monetary Policy": 3, "Yield Curve": 2,
  "Equities": 3, "Recession": 3, "Consumer Spending": 2, "Consumer Confidence": 2,
  "Currency": 3, "USD Strength": 2, "EM Risk": 2,
  "Commodities": 3, "Commodity Risk": 2, "Inflation Pass-Through": 2,
  "Credit": 3, "Credit Spreads": 2, "Banking": 2,
};

const MARKET_TICKERS: Record<AssetClass, Array<{ ticker: string; name: string }>> = {
  "Rates": [
    { ticker: "^TNX", name: "10-Year Treasury" },
    { ticker: "^FVX", name: "5-Year Treasury" },
    { ticker: "^TYX", name: "30-Year Treasury" }
  ],
  "Equities": [
    { ticker: "^GSPC", name: "S&P 500" },
    { ticker: "^IXIC", name: "Nasdaq Composite" },
    { ticker: "^RUT", name: "Russell 2000" }
  ],
  "FX": [
    { ticker: "DX-Y.NYB", name: "US Dollar Index" },
    { ticker: "EURUSD=X", name: "EUR/USD" },
    { ticker: "JPY=X", name: "USD/JPY" }
  ],
  "Commodities": [
    { ticker: "CL=F", name: "Crude Oil" },
    { ticker: "GC=F", name: "Gold" },
    { ticker: "HG=F", name: "Copper" }
  ],
  "Credit": [
    { ticker: "HYG", name: "High Yield Bonds" },
    { ticker: "LQD", name: "Investment Grade Bonds" },
    { ticker: "TLT", name: "Long-Term Treasury" }
  ]
};

let marketDataCache: { data: Record<AssetClass, number>; timestamp: number } | null = null;
let marketTimeseriesCache: { data: Record<string, { date: string; value: number }[]>; timestamp: number } | null = null;

const INSTITUTIONAL_SOURCES = [
  "site:federalreserve.gov",
  "site:ecb.europa.eu",
  "site:bankofengland.co.uk",
  "site:boj.or.jp",
  "site:bis.org",
  "site:imf.org",
  "site:worldbank.org"
];

async function fetchInstitutionalLens(themeName: string, topArticles: ClassifiedArticle[]): Promise<InstitutionalSource[]> {
  try {
    const keywords = topArticles.slice(0, 3).map(a => a.title.split(' ').slice(0, 5).join(' ')).join(' OR ');
    const siteQuery = INSTITUTIONAL_SOURCES.slice(0, 3).join(' OR ');
    const query = `(${keywords}) (${siteQuery})`;

    const url = `https://www.googleapis.com/customsearch/v1?key=${process.env.GOOGLE_API_KEY}&cx=${process.env.GOOGLE_CX}&q=${encodeURIComponent(query)}&num=3`;
    const res = await fetch(url);
    if (!res.ok) return [];

    const data = await res.json();
    const items = data.items || [];

    return items.slice(0, 3).map((item: any) => ({
      source: new URL(item.link).hostname.replace('www.', ''),
      title: item.title,
      snippet: item.snippet,
      url: item.link
    }));
  } catch (err) {
    console.error("Failed to fetch institutional lens:", err);
    return [];
  }
}

async function fetchMarketMoves(): Promise<Record<AssetClass, number>> {
  if (marketDataCache && Date.now() - marketDataCache.timestamp < 3600000) {
    return marketDataCache.data;
  }

  const moves: Record<AssetClass, number> = { Rates: 0, Equities: 0, FX: 0, Commodities: 0, Credit: 0 };

  for (const [asset, tickers] of Object.entries(MARKET_TICKERS)) {
    const ticker = tickers[0].ticker; // Use first ticker for each asset class
    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
      const res = await fetch(url);
      if (!res.ok) continue;
      const data = await res.json();
      const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
      const validCloses = closes.filter((c: any) => c != null);
      if (validCloses.length >= 2) {
        const latest = validCloses[validCloses.length - 1];
        const previous = validCloses[validCloses.length - 2];
        moves[asset as AssetClass] = ((latest - previous) / previous) * 100;
      }
    } catch (err) {
      console.error(`Failed to fetch ${ticker}:`, err);
    }
  }

  marketDataCache = { data: moves, timestamp: Date.now() };
  return moves;
}

interface EconomicIndicator {
  name: string;
  category: string;
  value: number;
  previousValue: number;
  change: number;
  changePercent: number;
  unit: string;
  updatedAt: string;
}

const FRED_SERIES_CONFIG: { seriesId: string; name: string; unit: string; transform: "level" | "yoy" | "mom" | "payroll_change" }[] = [
  { seriesId: "CPIAUCSL", name: "US CPI YoY", unit: "%", transform: "yoy" },
  { seriesId: "CPILFESL", name: "US Core CPI YoY", unit: "%", transform: "yoy" },
  { seriesId: "PCEPI", name: "PCE Price Index", unit: "%", transform: "yoy" },
  { seriesId: "PCEPILFE", name: "Core PCE", unit: "%", transform: "yoy" },
  { seriesId: "PPIFIS", name: "Producer Price Index (PPI)", unit: "%", transform: "yoy" },
  { seriesId: "T5YIE", name: "Inflation Expectations (5Y Breakeven)", unit: "%", transform: "level" },
  { seriesId: "FEDFUNDS", name: "Fed Funds Rate", unit: "%", transform: "level" },
  { seriesId: "DGS10", name: "10Y Treasury Yield", unit: "%", transform: "level" },
  { seriesId: "DGS2", name: "2Y Treasury Yield", unit: "%", transform: "level" },
  { seriesId: "UNRATE", name: "US Unemployment Rate", unit: "%", transform: "level" },
  { seriesId: "PAYEMS", name: "Nonfarm Payrolls", unit: "K", transform: "payroll_change" },
  { seriesId: "JTSJOL", name: "Job Openings (JOLTS)", unit: "M", transform: "mom" },
  { seriesId: "CIVPART", name: "Labor Force Participation Rate", unit: "%", transform: "level" },
  { seriesId: "A191RL1Q225SBEA", name: "GDP Growth Rate", unit: "%", transform: "level" },
  { seriesId: "INDPRO", name: "Industrial Production", unit: "", transform: "mom" },
  { seriesId: "UMCSENT", name: "Consumer Confidence Index", unit: "", transform: "level" },
  { seriesId: "USALOLITONOSTSAM", name: "Leading Economic Index (LEI)", unit: "", transform: "level" },
];

const MARKET_INDICATOR_TICKERS: { ticker: string; name: string; unit: string }[] = [
  { ticker: "^VIX", name: "VIX Volatility Index", unit: "" },
  { ticker: "DX-Y.NYB", name: "DXY (US Dollar Index)", unit: "" },
  { ticker: "CL=F", name: "Oil (WTI)", unit: "$/bbl" },
  { ticker: "GC=F", name: "Gold", unit: "$/oz" },
  { ticker: "^GSPC", name: "S&P 500 Index", unit: "" },
  { ticker: "HG=F", name: "Copper", unit: "$/lb" },
];

let economicIndicatorsCache: { sections: { title: string; indicators: EconomicIndicator[] }[]; timestamp: number } | null = null;
const ECONOMIC_CACHE_MS = 60 * 60 * 1000;

async function fetchFredObservations(seriesId: string, limit: number): Promise<{ date: string; value: number }[]> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) return [];
  const url = `https://api.stlouisfed.org/fred/series/observations?series_id=${seriesId}&api_key=${apiKey}&file_type=json&sort_order=desc&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) return [];
  const data = await res.json();
  const obs = data?.observations || [];
  return obs
    .filter((o: any) => o.value !== "." && o.value != null)
    .map((o: any) => ({ date: o.date, value: parseFloat(o.value) }));
}

function formatFredDate(dateStr: string): string {
  if (dateStr.length === 7) {
    const [y, m] = dateStr.split("-");
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${months[parseInt(m, 10) - 1]} ${y}`;
  }
  if (dateStr.length >= 4 && dateStr[4] === "Q") return dateStr.replace("-", " ");
  return dateStr;
}

async function fetchFredIndicator(
  config: (typeof FRED_SERIES_CONFIG)[0]
): Promise<{ name: string; value: number; previousValue: number; changePercent: number; unit: string; updatedAt: string } | null> {
  try {
    const limit = config.transform === "yoy" ? 14 : config.transform === "payroll_change" ? 4 : 3;
    const obs = await fetchFredObservations(config.seriesId, limit);
    if (obs.length < 2) return null;

    const latest = obs[0].value;
    const prev = obs[1].value;
    const prev2 = obs[2]?.value;
    let value: number;
    let previousValue: number;
    let changePercent: number;

    if (config.transform === "yoy") {
      if (obs.length < 13) return null;
      const yearAgo = obs[12].value;
      value = ((latest / yearAgo) - 1) * 100;
      const prevYearAgo = obs[13]?.value;
      previousValue = prevYearAgo != null ? ((prev / prevYearAgo) - 1) * 100 : value;
      changePercent = prevYearAgo != null ? ((value - previousValue) / Math.abs(previousValue)) * 100 : 0;
    } else if (config.transform === "payroll_change") {
      if (obs.length < 3) return null;
      value = Math.round(latest - prev);
      previousValue = Math.round(prev - prev2);
      changePercent = previousValue !== 0 ? ((value - previousValue) / Math.abs(previousValue)) * 100 : 0;
    } else if (config.transform === "mom") {
      value = config.unit === "M" ? Math.round((latest / 1000) * 100) / 100 : latest;
      previousValue = config.unit === "M" ? Math.round((prev / 1000) * 100) / 100 : prev;
      changePercent = prev !== 0 ? ((latest - prev) / prev) * 100 : 0;
    } else {
      value = Math.round(latest * 100) / 100;
      previousValue = Math.round(prev * 100) / 100;
      changePercent = prev !== 0 ? ((latest - prev) / prev) * 100 : 0;
    }

    return {
      name: config.name,
      value,
      previousValue,
      changePercent,
      unit: config.unit,
      updatedAt: formatFredDate(obs[0].date),
    };
  } catch {
    return null;
  }
}

async function fetchYahooIndicator(ticker: string, name: string, unit: string): Promise<{ name: string; value: number; previousValue: number; changePercent: number; unit: string; updatedAt: string } | null> {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=5d`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const data = await res.json();
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];
    const validCloses = closes.filter((c: any) => c != null);
    if (validCloses.length < 2) return null;
    const latest = validCloses[validCloses.length - 1];
    const previous = validCloses[validCloses.length - 2];
    const changePercent = ((latest - previous) / previous) * 100;
    const ts = data?.chart?.result?.[0]?.timestamp?.[validCloses.length - 1];
    const dateStr = ts ? new Date(ts * 1000).toLocaleDateString("en-US", { month: "short", year: "numeric" }) : "";
    return {
      name,
      value: Math.round(latest * 100) / 100,
      previousValue: Math.round(previous * 100) / 100,
      changePercent,
      unit,
      updatedAt: dateStr,
    };
  } catch {
    return null;
  }
}

async function fetchEconomicIndicators(): Promise<{ title: string; indicators: EconomicIndicator[] }[]> {
  if (economicIndicatorsCache && Date.now() - economicIndicatorsCache.timestamp < ECONOMIC_CACHE_MS) {
    return economicIndicatorsCache.sections;
  }

  const sections: { title: string; indicators: EconomicIndicator[] }[] = [];
  const fredKey = process.env.FRED_API_KEY;

  if (fredKey) {
    const inflationConfigs = FRED_SERIES_CONFIG.filter((c) =>
      ["CPIAUCSL", "CPILFESL", "PCEPI", "PCEPILFE", "WPSFD49207", "MICH"].includes(c.seriesId)
    );
    const inflationIndicators = (await Promise.all(inflationConfigs.map((c) => fetchFredIndicator(c)))).filter(Boolean) as EconomicIndicator[];
    if (inflationIndicators.length > 0) {
      sections.push({ title: "Inflation", indicators: inflationIndicators.map((i) => ({ ...i, category: "inflation", change: i.value - i.previousValue })) });
    }

    const monetaryConfigs = FRED_SERIES_CONFIG.filter((c) => ["FEDFUNDS", "DGS10", "DGS2"].includes(c.seriesId));
    const monetaryRaw = (await Promise.all(monetaryConfigs.map((c) => fetchFredIndicator(c)))).filter(Boolean) as EconomicIndicator[];
    const d10 = monetaryRaw.find((i) => i.name === "10Y Treasury Yield");
    const d2 = monetaryRaw.find((i) => i.name === "2Y Treasury Yield");
    const yieldCurve =
      d10 && d2
        ? {
            name: "Yield Curve (10Y – 2Y Spread)",
            value: Math.round((d10.value - d2.value) * 100) / 100,
            previousValue: Math.round((d10.previousValue - d2.previousValue) * 100) / 100,
            changePercent: d10.previousValue !== d2.previousValue ? (((d10.value - d2.value) - (d10.previousValue - d2.previousValue)) / Math.abs(d10.previousValue - d2.previousValue)) * 100 : 0,
            unit: "%",
            updatedAt: d10.updatedAt,
            category: "monetary",
            change: (d10.value - d2.value) - (d10.previousValue - d2.previousValue),
          }
        : null;
    const monetaryIndicators = [...monetaryRaw.map((i) => ({ ...i, category: "monetary" as const, change: i.value - i.previousValue })), ...(yieldCurve ? [yieldCurve] : [])];
    if (monetaryIndicators.length > 0) sections.push({ title: "Monetary Policy", indicators: monetaryIndicators });

    const laborConfigs = FRED_SERIES_CONFIG.filter((c) => ["UNRATE", "PAYEMS", "JTSJOL", "CIVPART"].includes(c.seriesId));
    const laborIndicators = (await Promise.all(laborConfigs.map((c) => fetchFredIndicator(c)))).filter(Boolean) as EconomicIndicator[];
    if (laborIndicators.length > 0) {
      sections.push({ title: "Labor Market", indicators: laborIndicators.map((i) => ({ ...i, category: "labor", change: i.value - i.previousValue })) });
    }

    const growthConfigs = FRED_SERIES_CONFIG.filter((c) => ["A191RL1Q225SBEA", "INDPRO"].includes(c.seriesId));
    const growthIndicators = (await Promise.all(growthConfigs.map((c) => fetchFredIndicator(c)))).filter(Boolean) as EconomicIndicator[];
    if (growthIndicators.length > 0) {
      sections.push({ title: "Economic Growth", indicators: growthIndicators.map((i) => ({ ...i, category: "growth", change: i.value - i.previousValue })) });
    }

    const leadingConfigs = FRED_SERIES_CONFIG.filter((c) => ["UMCSENT", "USALOLITONOSTSAM"].includes(c.seriesId));
    const leadingIndicators = (await Promise.all(leadingConfigs.map((c) => fetchFredIndicator(c)))).filter(Boolean) as EconomicIndicator[];
    if (leadingIndicators.length > 0) {
      sections.push({ title: "Leading Indicators", indicators: leadingIndicators.map((i) => ({ ...i, category: "leading", change: i.value - i.previousValue })) });
    }
  }

  const marketIndicators = (await Promise.all(MARKET_INDICATOR_TICKERS.map((t) => fetchYahooIndicator(t.ticker, t.name, t.unit)))).filter(Boolean) as EconomicIndicator[];
  if (marketIndicators.length > 0) {
    sections.push({ title: "Market Indicators", indicators: marketIndicators.map((i) => ({ ...i, category: "market", change: i.value - i.previousValue })) });
  }

  economicIndicatorsCache = { sections, timestamp: Date.now() };
  return sections;
}

async function fetchMarketTimeseries(): Promise<Record<string, { date: string; value: number }[]>> {
  if (marketTimeseriesCache && Date.now() - marketTimeseriesCache.timestamp < 3600000) {
    return marketTimeseriesCache.data;
  }

  const timeseries: Record<string, { date: string; value: number }[]> = {};

  for (const [asset, tickers] of Object.entries(MARKET_TICKERS)) {
    for (const { ticker, name } of tickers) {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}?interval=1d&range=14d`;
        const res = await fetch(url);
        if (!res.ok) continue;
        const data = await res.json();
        const timestamps = data?.chart?.result?.[0]?.timestamp || [];
        const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close || [];

        const points: { date: string; value: number }[] = [];
        for (let i = 0; i < timestamps.length; i++) {
          if (closes[i] != null) {
            const date = new Date(timestamps[i] * 1000).toISOString().split('T')[0];
            points.push({ date, value: Math.round(closes[i] * 100) / 100 });
          }
        }
        timeseries[`${asset}:${ticker}`] = points;
      } catch (err) {
        console.error(`Failed to fetch timeseries for ${ticker}:`, err);
      }
    }
  }

  marketTimeseriesCache = { data: timeseries, timestamp: Date.now() };
  return timeseries;
}

async function computeAssetImpactsAI(articles: ClassifiedArticle[]): Promise<AssetImpact[]> {
  try {
    const [marketMoves] = await Promise.all([fetchMarketMoves()]);
    const topArticles = articles.slice(0, 8);
    const articleText = topArticles.map((a, i) => `${i + 1}. "${a.title}"${a.description ? ` — ${a.description.slice(0, 80)}` : ""}`).join("\n");

    const prompt = `Analyze these articles and determine asset class impact levels.

Articles:
${articleText}

Rules:
- Output ONLY valid JSON, no markdown.
- For each asset class (Rates, Equities, FX, Commodities, Credit), assign level: "High", "Medium", or "Low"
- If not supported by provided text, return "Low"
- "why" must be max 10 words, factual, based on article content

Respond with exactly:
{"Rates":{"level":"...","why":"..."},"Equities":{"level":"...","why":"..."},"FX":{"level":"...","why":"..."},"Commodities":{"level":"...","why":"..."},"Credit":{"level":"...","why":"..."}}`;

    const groqResult = await groq.chat.completions.create({
      model: "llama-3.3-70b-versatile",
      messages: [{ role: "user", content: prompt }],
      max_tokens: 400,
    });

    const content = groqResult.choices[0]?.message?.content || "";
    let parsed;
    try { parsed = JSON.parse(content); }
    catch { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error("Invalid JSON"); }

    const impacts: AssetImpact[] = [];
    for (const asset of ["Rates", "Equities", "FX", "Commodities", "Credit"] as AssetClass[]) {
      const data = parsed[asset];
      const marketMove = marketMoves[asset];
      let level = data?.level as AssetImpactLevel || "Low";

      if (Math.abs(marketMove) > 2) {
        level = "High";
      } else if (Math.abs(marketMove) > 1 && level === "Low") {
        level = "Medium";
      }

      impacts.push({ asset, level, marketMove: Math.round(marketMove * 100) / 100 });
    }
    return impacts.length > 0 ? impacts : [{ asset: "Equities", level: "Low", marketMove: 0 }];
  } catch (err) {
    console.error("AI asset impact failed, using rule-based fallback:", err);
    return [];
  }
}

function computeAssetImpacts(themeName: string, heatScore?: number): AssetImpact[] {
  const taxonomy = FIXED_TAXONOMY[themeName];
  const riskTags = taxonomy?.riskTags || [];
  const momentumMultiplier = heatScore ? Math.max(0.5, Math.min(1.5, heatScore / 50)) : 1;
  const assetScores: Record<AssetClass, number> = { Rates: 0, Equities: 0, FX: 0, Commodities: 0, Credit: 0 };
  for (const tag of riskTags) {
    const assets = RISK_TAG_TO_ASSET[tag];
    if (assets) {
      const weight = RISK_TAG_WEIGHTS[tag] || 1;
      for (const asset of assets) {
        assetScores[asset] += weight;
      }
    }
  }
  const impacts: AssetImpact[] = [];
  for (const [asset, rawScore] of Object.entries(assetScores)) {
    if (rawScore > 0) {
      const adjustedScore = rawScore * momentumMultiplier;
      const level: AssetImpactLevel = adjustedScore >= 4 ? "High" : adjustedScore >= 2 ? "Medium" : "Low";
      impacts.push({ asset: asset as AssetClass, level });
    }
  }
  if (impacts.length === 0) impacts.push({ asset: "Equities", level: "Low" });
  impacts.sort((a, b) => { const order = { High: 0, Medium: 1, Low: 2 }; return order[a.level] - order[b.level]; });
  return impacts;
}

function computeRelatedThemes(
  currentName: string,
  allThemes: { name: string; articles: ClassifiedArticle[]; riskTags: string[] }[]
): RelatedTheme[] {
  const currentTheme = allThemes.find(t => t.name === currentName);
  if (!currentTheme) return [];
  const currentKeywords = new Set<string>();
  for (const a of currentTheme.articles) {
    const words = `${a.title} ${a.description}`.toLowerCase().split(/\W+/).filter(w => w.length > 4);
    words.forEach(w => currentKeywords.add(w));
  }
  const currentTags = new Set(currentTheme.riskTags);
  const currentRegions = new Set(currentTheme.articles.map(a => a.region));
  const scores: { name: string; strength: number }[] = [];
  for (const other of allThemes) {
    if (other.name === currentName) continue;
    let score = 0;
    const otherTags = new Set(other.riskTags);
    for (const tag of currentTags) { if (otherTags.has(tag)) score += 3; }
    const otherRegions = new Set(other.articles.map(a => a.region));
    for (const r of currentRegions) { if (otherRegions.has(r) && r !== "Other" && r !== "Global") score += 1; }
    const otherKeywords = new Set<string>();
    for (const a of other.articles) {
      const words = `${a.title} ${a.description}`.toLowerCase().split(/\W+/).filter(w => w.length > 4);
      words.forEach(w => otherKeywords.add(w));
    }
    let kwOverlap = 0;
    for (const kw of currentKeywords) { if (otherKeywords.has(kw)) kwOverlap++; }
    score += Math.min(kwOverlap / 5, 5);
    if (score > 0) scores.push({ name: other.name, strength: Math.round(score * 10) / 10 });
  }
  scores.sort((a, b) => b.strength - a.strength);
  return scores.slice(0, 5);
}

interface FetchDebug {
  fetchedCount: number;
  dedupedCount: number;
  filteredCount: number;
  topSources: { name: string; count: number }[];
  pagesRequested: number;
  queryLength: number;
}

const FIXED_TAXONOMY: Record<string, { keywords: string[]; riskTags: string[] }> = {
  "Inflation & Prices": {
    keywords: ["inflation", "cpi", "consumer price", "price index", "pce", "core inflation", "disinflation", "deflation", "cost of living"],
    riskTags: ["Rates", "Equities", "Duration Risk", "Consumer Spending"],
  },
  "Central Bank Policy": {
    keywords: ["federal reserve", "fed ", "fed's", "fomc", "rate cut", "rate hike", "interest rate", "monetary policy", "powell", "fed funds", "hawkish", "dovish", "quantitative tightening", "qt ", "qe ", "central bank", "ecb", "bank of japan", "boj", "bank of england", "boe", "pboc", "rba", "bank of canada", "riksbank", "snb"],
    riskTags: ["Monetary Policy", "USD Strength", "EM Risk", "Credit", "Global Monetary Policy", "Currency", "Rate Differential", "EM Rates"],
  },
  "Growth & Recession": {
    keywords: ["gdp", "economic growth", "expansion", "growth rate", "productivity", "output", "economic activity", "business cycle", "industrial production", "manufacturing pmi", "services pmi", "recession", "contraction", "slowdown", "downturn", "hard landing", "soft landing", "yield curve inversion", "inverted yield", "consumer spending", "retail sales", "consumer confidence", "discretionary spending", "consumer sentiment", "shopping", "e-commerce"],
    riskTags: ["Recession", "Equities", "Consumer Confidence", "Manufacturing", "Yield Curve", "Consumer Spending"],
  },
  "Employment & Labor": {
    keywords: ["unemployment", "jobless", "payroll", "nonfarm", "labor market", "job report", "wage growth", "labor force", "participation rate", "job opening", "jolts", "layoff", "hiring"],
    riskTags: ["Labor Market", "Consumer Spending", "Equities", "Recession"],
  },
  "Geopolitics & Conflicts": {
    keywords: ["geopolit", "war ", "conflict", "military", "nato", "invasion", "diplomatic", "nuclear threat", "missile", "tension", "escalation", "sanction", "embargo", "export control", "trade restriction", "economic warfare", "financial sanction", "asset freeze", "swift ban", "strike", "attack", "projectile", "combat", "hostilities"],
    riskTags: ["Geopolitics", "Defense", "Supply Disruption", "Commodity Risk", "Supply Chain", "Currency", "Trade War"],
  },
  "Trade & Tariffs": {
    keywords: ["tariff", "trade war", "trade deal", "import dut", "export ban", "export control", "trade deficit", "trade surplus", "protectionism", "trade barrier", "customs"],
    riskTags: ["Trade War", "Supply Chain", "Consumer Prices", "Manufacturing"],
  },
  "Energy & Commodities": {
    keywords: ["oil", "crude", "brent", "wti", "opec", "energy price", "natural gas", "lng", "petroleum", "gasoline", "fuel", "commodity", "gold", "silver", "copper", "metal", "agricultural", "wheat", "corn", "soybean", "commodity index", "raw material"],
    riskTags: ["Commodities", "Inflation Pass-Through", "Transport", "Energy Sector", "Commodities Demand", "Supply Disruption"],
  },
  "China Economy": {
    keywords: ["china econom", "chinese econom", "yuan", "renminbi", "beijing", "xi jinping", "china gdp", "china trade", "evergrande", "property sector", "property crisis", "china stimulus"],
    riskTags: ["China Risk", "EM Contagion", "Commodities Demand", "Supply Chain"],
  },
  "Credit & Banking": {
    keywords: ["credit spread", "high yield", "investment grade", "corporate bond", "credit risk", "default rate", "distressed debt", "junk bond", "credit quality", "bank crisis", "bank fail", "bank run", "deposit", "liquidity crisis", "systemic risk", "financial stability", "bank stress", "fdic", "capital ratio", "housing", "mortgage", "real estate", "home price", "home sales", "housing start", "property market", "mortgage rate", "refinancing", "foreclosure"],
    riskTags: ["Credit", "Credit Spreads", "Banking", "Recession", "Sovereign Risk", "Regulation", "Consumer Spending"],
  },
  "Bond Markets & Rates": {
    keywords: ["treasury", "treasuries", "yield", "bond", "10-year", "10y", "2-year", "2y", "30-year", "gilt", "bund", "duration", "convexity"],
    riskTags: ["Rates", "Duration", "Duration Risk", "Sovereign Risk"],
  },
  "Currency & Emerging Markets": {
    keywords: ["dollar", "currency", "forex", "fx market", "exchange rate", "dollar strength", "dollar weakness", "currency war", "devaluation", "revaluation", "dxy", "euro dollar", "yen carry", "emerging market", "em debt", "em crisis", "capital flight", "contagion", "developing econom", "frontier market", "em currency", "sovereign default", "debt distress"],
    riskTags: ["Currency", "USD Strength", "EM Risk", "Rate Differential", "EM Contagion", "Sovereign Risk"],
  },
  "Fiscal Policy": {
    keywords: ["fiscal policy", "government spending", "budget deficit", "debt ceiling", "fiscal stimulus", "austerity", "tax policy", "infrastructure spending", "regulat", "compliance", "sec ", "finra", "banking rule", "capital requirement", "dodd-frank", "basel", "mica", "crypto regulat", "financial oversight"],
    riskTags: ["Sovereign Risk", "Rates", "Currency", "Regulation", "Compliance", "Banking", "Fintech"],
  },
};

const TAXONOMY_NAMES = Object.keys(FIXED_TAXONOMY);

interface EmergingRecord { label: string; articleId: string; publishedAt: string; }
const emergingHistory: EmergingRecord[] = [];
const ARTICLES_DB_PATH = join(process.cwd(), "data", "articles.json");
const FOURTEEN_DAYS_MS = 14 * 24 * 60 * 60 * 1000;

interface StorageDebug { totalStored: number; addedThisRefresh: number; pruned: number; earliestDate: string; latestDate: string; }

function loadStoredArticles(): ClassifiedArticle[] {
  try {
    if (existsSync(ARTICLES_DB_PATH)) {
      const raw = readFileSync(ARTICLES_DB_PATH, "utf-8");
      return JSON.parse(raw) as ClassifiedArticle[];
    }
  } catch (err) { console.error("Failed to load articles DB:", err); }
  return [];
}

function saveStoredArticles(articles: ClassifiedArticle[]): void {
  try { writeFileSync(ARTICLES_DB_PATH, JSON.stringify(articles), "utf-8"); }
  catch (err) { console.error("Failed to save articles DB:", err); }
}

function mergeAndPruneArticles(existing: ClassifiedArticle[], newArticles: ClassifiedArticle[]): { merged: ClassifiedArticle[]; debug: StorageDebug } {
  const byUrl = new Map<string, ClassifiedArticle>();
  for (const a of existing) byUrl.set(a.url, a);
  let addedThisRefresh = 0;
  for (const a of newArticles) { if (!byUrl.has(a.url)) addedThisRefresh++; byUrl.set(a.url, a); }
  const cutoff = new Date(Date.now() - FOURTEEN_DAYS_MS);
  const allArticles = Array.from(byUrl.values());
  const pruned = allArticles.filter(a => new Date(a.publishedAt) < cutoff).length;
  const merged = allArticles.filter(a => new Date(a.publishedAt) >= cutoff);
  merged.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const dates = merged.map(a => a.publishedAt).sort();
  const debug: StorageDebug = { totalStored: merged.length, addedThisRefresh, pruned, earliestDate: dates[0] || "", latestDate: dates[dates.length - 1] || "" };
  return { merged, debug };
}

let articleHistory: ClassifiedArticle[] = loadStoredArticles();

function addToHistory(articles: ClassifiedArticle[]): StorageDebug {
  const { merged, debug } = mergeAndPruneArticles(articleHistory, articles);
  articleHistory = merged;
  saveStoredArticles(merged);
  return debug;
}

function getInstitutionalMemory(themeName: string, currentArticleIds: Set<string>, limit = 5): ClassifiedArticle[] {
  const pastArticles = articleHistory.filter(a => a.theme === themeName && !currentArticleIds.has(a.id));
  pastArticles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  return pastArticles.slice(0, limit);
}

function classifyArticle(article: NewsArticle): ClassifiedArticle {
  const text = `${article.title} ${article.description}`.toLowerCase();
  let bestTheme: string | null = null;
  let bestScore = 0;
  for (const [themeName, config] of Object.entries(FIXED_TAXONOMY)) {
    let score = 0;
    for (const kw of config.keywords) { if (text.includes(kw)) score += kw.length; }
    if (score > bestScore) { bestScore = score; bestTheme = themeName; }
  }
  const region = detectRegion(article.title, article.description);
  if (bestTheme && bestScore >= 3) return { ...article, theme: bestTheme, region };
  const emergingLabel = deriveEmergingLabel(article);
  return { ...article, theme: "Emerging", emerging_label: emergingLabel, region };
}

function deriveEmergingLabel(article: NewsArticle): string {
  const text = `${article.title} ${article.description}`.toLowerCase();
  const emergingPatterns: [RegExp, string][] = [
    [/crypto|bitcoin|ethereum|blockchain|defi/, "Crypto Market Moves"],
    [/ai |artificial intelligence|machine learning|chatgpt|openai/, "AI Industry Disruption"],
    [/climate|carbon|emission|green energy|renewable/, "Climate Policy Shift"],
    [/housing|mortgage|real estate|home price/, "Housing Market Stress"],
    [/bank(ing)? crisis|bank fail|bank run|deposit/, "Banking Sector Stress"],
    [/debt ceiling|government shutdown|fiscal/, "US Fiscal Standoff"],
    [/election|vote|poll|campaign|ballot/, "Election Uncertainty"],
    [/supply chain|shipping|freight|logistics/, "Supply Chain Disruption"],
    [/tech layoff|job cut|workforce reduction/, "Tech Sector Layoffs"],
    [/cyber|hack|breach|ransomware/, "Cybersecurity Threat"],
    [/semiconductor|chip|fab|tsmc|nvidia/, "Semiconductor Race"],
    [/pharma|drug|fda|vaccine|health/, "Pharma & Health Policy"],
    [/japan|yen|nikkei/, "Japan Economic Shift"],
    [/india|rupee|modi/, "India Growth Story"],
    [/europe|eu |eurozone|euro /, "European Economic Outlook"],
  ];
  for (const [pattern, label] of emergingPatterns) { if (pattern.test(text)) return label; }
  return "";
}

function computeHeatStatus(zScore: number, count3d: number): "hot" | "warm" | "cool" {
  if (zScore >= 1.5 && count3d >= 5) return "hot";
  if (zScore >= 0.5 && count3d >= 3) return "warm";
  return "cool";
}

function computeTrend(articles: ClassifiedArticle[]): "up" | "down" | "flat" {
  if (articles.length < 2) return "flat";
  const sorted = [...articles].sort((a, b) => new Date(a.publishedAt).getTime() - new Date(b.publishedAt).getTime());
  const midpoint = Math.floor(sorted.length / 2);
  const firstHalf = sorted.slice(0, midpoint).length;
  const secondHalf = sorted.slice(midpoint).length;
  if (secondHalf > firstHalf) return "up";
  if (secondHalf < firstHalf) return "down";
  return "flat";
}

const SOURCE_QUALITY: Record<string, number> = {
  "BBC Business": 1.0, "NYT Economy": 1.0, "Reuters": 1.0, "Financial Times": 1.0,
  "Wall Street Journal": 0.9, "Bloomberg": 0.9, "The Economist": 0.9,
  "CNBC": 0.8, "MarketWatch": 0.8, "CNN Business": 0.8,
};

function computeRawScore(allArticlesForTheme: ClassifiedArticle[], totalArticles3d: number, totalArticles14d: number): { rawScore: number; count3d: number; avgDaily14d: number; count5d: number } {
  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(now.getTime() - 5 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const count3d = allArticlesForTheme.filter(a => new Date(a.publishedAt) >= threeDaysAgo).length;
  const count5d = allArticlesForTheme.filter(a => new Date(a.publishedAt) >= fiveDaysAgo).length;
  const articles14d = allArticlesForTheme.filter(a => new Date(a.publishedAt) >= fourteenDaysAgo);
  const avgDaily14d = articles14d.length / 14;

  // Use square root instead of log for better volume sensitivity
  const volumeScore = Math.sqrt(articles14d.length);

  const share3d = totalArticles3d > 0 ? count3d / totalArticles3d : 0;
  const share14d = totalArticles14d > 0 ? articles14d.length / totalArticles14d : 0;
  const attentionShift = share14d > 0 ? share3d / share14d : 1;

  const newsVelocity = count3d / 3;

  const volumeDampening = articles14d.length < 20 ? 0.5 : 1.0;
  const momentum = (attentionShift + newsVelocity * 0.1) * volumeDampening;

  const credibilitySum = articles14d.reduce((sum, a) => sum + (SOURCE_QUALITY[a.source] || 0.5), 0);
  const credibility = articles14d.length > 0 ? credibilitySum / articles14d.length : 0.5;

  // Increase volume weight from 0.6 to 0.75
  const rawScore = 0.75 * volumeScore + 0.20 * momentum + 0.05 * credibility;

  return { rawScore, count3d, avgDaily14d, count5d };
}

function computeTimeseries(allArticles: ClassifiedArticle[]): TimeseriesPoint[] {
  const now = new Date();
  const points: TimeseriesPoint[] = [];
  for (let i = 14; i >= 1; i--) {
    const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    const dateStr = d.toISOString().split("T")[0];
    const count = allArticles.filter(a => a.publishedAt.startsWith(dateStr)).length;
    points.push({ date: dateStr, count });
  }
  return points;
}

function computeArticlesByDate(allArticles: ClassifiedArticle[]): Record<string, ClassifiedArticle[]> {
  const byDate: Record<string, ClassifiedArticle[]> = {};
  for (const article of allArticles) {
    const dateStr = article.publishedAt.split("T")[0];
    if (!byDate[dateStr]) byDate[dateStr] = [];
    byDate[dateStr].push(article);
  }
  for (const dateStr in byDate) {
    byDate[dateStr].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  }
  return byDate;
}

function computeMilestones(articles: ClassifiedArticle[], limit = 5): string[] {
  const sorted = [...articles].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
  const milestones: string[] = [];
  const seen = new Set<string>();
  for (const a of sorted) {
    const title = a.title.trim();
    const short = title.length > 60 ? title.slice(0, 57) + "..." : title;
    const key = short.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 30);
    if (!seen.has(key)) { seen.add(key); milestones.push(short); }
    if (milestones.length >= limit) break;
  }
  return milestones;
}

async function groupByThemes(articles: ClassifiedArticle[], includeInstitutional = false): Promise<ThemeGroup[]> {
  const fixedGroups: Record<string, ClassifiedArticle[]> = {};
  const emergingGroups: Record<string, ClassifiedArticle[]> = {};
  for (const a of articles) {
    if (!a.theme) continue; // Skip unclassified articles
    if (a.theme === "Emerging") {
      const label = a.emerging_label;
      if (!label) continue;
      if (!emergingGroups[label]) emergingGroups[label] = [];
      emergingGroups[label].push(a);
      emergingHistory.push({ label, articleId: a.id, publishedAt: a.publishedAt });
    } else {
      if (!fixedGroups[a.theme]) fixedGroups[a.theme] = [];
      fixedGroups[a.theme].push(a);
    }
  }

  // Fetch corporate signals and count per theme
  const corporateSignals = await detectCorporateSignals();
  const signalsByTheme: Record<string, number> = {};
  for (const signal of corporateSignals) {
    signalsByTheme[signal.detectedTheme] = (signalsByTheme[signal.detectedTheme] || 0) + 1;
  }

  // Step 1: Compute raw scores for all themes
  const themeRawScores: Array<{ name: string; group: ClassifiedArticle[]; rawScore: number; debugCounts: ThemeDebugCounts; isEmerging: boolean; corporateSignals: number }> = [];

  const now = new Date();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);

  const allArticles = [...Object.values(fixedGroups).flat(), ...Object.values(emergingGroups).flat()];
  const totalArticles3d = allArticles.filter(a => new Date(a.publishedAt) >= threeDaysAgo).length;
  const totalArticles14d = allArticles.filter(a => new Date(a.publishedAt) >= fourteenDaysAgo).length;

  for (const [name, group] of Object.entries(fixedGroups)) {
    const { rawScore, count3d, count5d, avgDaily14d } = computeRawScore(group, totalArticles3d, totalArticles14d);
    const corpSignals = signalsByTheme[name] || 0;
    const adjustedScore = rawScore + (corpSignals * 2);
    themeRawScores.push({ name, group, rawScore: adjustedScore, debugCounts: { count3d, count5d, avgDaily14d: Math.round(avgDaily14d * 100) / 100 }, isEmerging: false, corporateSignals: corpSignals });
  }

  for (const [label, group] of Object.entries(emergingGroups)) {
    const { rawScore, count3d, count5d, avgDaily14d } = computeRawScore(group, totalArticles3d, totalArticles14d);
    const corpSignals = signalsByTheme[label] || 0;
    const adjustedScore = rawScore + (corpSignals * 2);
    themeRawScores.push({ name: label, group, rawScore: adjustedScore, debugCounts: { count3d, count5d, avgDaily14d: Math.round(avgDaily14d * 100) / 100 }, isEmerging: true, corporateSignals: corpSignals });
  }

  // Step 2: Normalize scores across all themes
  const rawScores = themeRawScores.map(t => t.rawScore);
  const minRaw = Math.min(...rawScores);
  const maxRaw = Math.max(...rawScores);

  console.log('[HEAT SCORE DEBUG] Raw score range:', { minRaw, maxRaw, totalThemes: themeRawScores.length });
  console.log('[HEAT SCORE DEBUG] All raw scores:', themeRawScores.map(t => ({ name: t.name, rawScore: t.rawScore.toFixed(2) })));

  // Load previous scores for smoothing
  const scoresPath = join(process.cwd(), "data", "theme_scores.json");
  const previousScores: Record<string, number> = existsSync(scoresPath) ? JSON.parse(readFileSync(scoresPath, "utf-8")) : {};

  // Load previous heat states for narrative persistence
  const heatStatePath = join(process.cwd(), "data", "theme_heat_state.json");
  const previousHeatState: Record<string, { heat: string; days: number }> = existsSync(heatStatePath) ? JSON.parse(readFileSync(heatStatePath, "utf-8")) : {};

  const themes: ThemeGroup[] = [];
  const updatedScores: Record<string, number> = {};
  const updatedHeatState: Record<string, { heat: string; days: number }> = {};
  let idx = 0;

  for (const themeData of themeRawScores) {
    // Use article count as primary driver, with momentum and corporate signals
    const articleCount = themeData.group.length;
    const baseScore = articleCount / 5; // 500 articles = 100 points

    // Momentum: recent activity vs 14-day average
    const count5d = themeData.debugCounts.count5d || 0;
    const avgDaily14d = themeData.debugCounts.avgDaily14d || 1;
    const momentum = count5d / (avgDaily14d * 5); // Ratio of 5-day to expected
    const momentumBonus = (momentum - 1) * 5; // +5 if 2x average, -5 if 0.5x average

    // Corporate signal boost: +2 points per signal
    const corpSignalBoost = (themeData.corporateSignals || 0) * 2;

    let rawScore = Math.min(Math.round(baseScore + momentumBonus + corpSignalBoost), 100);

    // Apply smoothing: 0.65 × yesterday + 0.35 × today
    let score = previousScores[themeData.name]
      ? Math.round(0.65 * previousScores[themeData.name] + 0.35 * rawScore)
      : rawScore;

    // Clamp score to minimum of 0
    score = Math.max(score, 0);

    updatedScores[themeData.name] = score;
    let heat: "hot" | "warm" | "cool" = score >= 70 ? "hot" : score >= 40 ? "warm" : "cool";

    // Absolute volume thresholds (override relative scoring)
    if (articleCount >= 150) {
      heat = "hot";
      score = Math.max(score, 75);
      updatedScores[themeData.name] = score;
    } else if (articleCount >= 50) {
      heat = heat === "cool" ? "warm" : heat;
      score = Math.max(score, 40);
      updatedScores[themeData.name] = score;
    }

    // Narrative Persistence: prevent rapid cooling
    const prevState = previousHeatState[themeData.name];
    if (prevState) {
      // HOT → WARM/COOL only after 2 days
      if (prevState.heat === "hot" && heat !== "hot" && prevState.days < 2) {
        heat = "hot";
      }
      // WARM → COOL only after 3 days
      if (prevState.heat === "warm" && heat === "cool" && prevState.days < 3) {
        heat = "warm";
      }
    }

    // Update heat state tracking
    if (prevState && prevState.heat === heat) {
      updatedHeatState[themeData.name] = { heat, days: prevState.days + 1 };
    } else {
      updatedHeatState[themeData.name] = { heat, days: 1 };
    }

    console.log(`[HEAT SCORE DEBUG] ${themeData.name}: rawScore=${themeData.rawScore.toFixed(2)} -> normalizedScore=${score}`);

    let assetImpacts = await computeAssetImpactsAI(themeData.group);
    if (assetImpacts.length === 0) {
      assetImpacts = computeAssetImpacts(themeData.name, score);
    }
    const institutionalLens = includeInstitutional && heat === "hot" ? await fetchInstitutionalLens(themeData.name, themeData.group) : undefined;

    const scoreChange = previousScores[themeData.name] ? score - previousScores[themeData.name] : 0;

    themes.push({
      id: `${themeData.isEmerging ? 'emerging' : 'fixed'}-${idx++}`,
      name: themeData.name,
      heat,
      score,
      scoreChange,
      trend: computeTrend(themeData.group),
      articles: themeData.group,
      isEmerging: themeData.isEmerging,
      emerging_label: themeData.isEmerging ? themeData.name : undefined,
      debugCounts: themeData.debugCounts,
      timeseries: computeTimeseries(themeData.group),
      milestones: computeMilestones(themeData.group),
      assetImpacts,
      relatedThemes: [],
      articlesByDate: computeArticlesByDate(themeData.group),
      institutionalLens,
      corporateSignals: themeData.corporateSignals
    });
  }

  // Save updated scores for next run
  writeFileSync(scoresPath, JSON.stringify(updatedScores, null, 2), "utf-8");
  writeFileSync(heatStatePath, JSON.stringify(updatedHeatState, null, 2), "utf-8");

  // Capture daily historical snapshot
  const historyPath = join(process.cwd(), "data", "theme_history.json");
  const history: ThemeHistory = existsSync(historyPath)
    ? JSON.parse(readFileSync(historyPath, "utf-8"))
    : {};

  const today = new Date().toISOString().split('T')[0];

  for (const theme of themes) {
    if (!history[theme.name]) {
      history[theme.name] = [];
    }

    const entries = history[theme.name];
    const lastEntry = entries[entries.length - 1];

    // Only add if date changed (prevent duplicates from multiple runs per day)
    if (!lastEntry || lastEntry.date !== today) {
      entries.push({
        date: today,
        score: theme.score,
        heat: theme.heat,
        count3d: theme.debugCounts?.count3d || 0,
        avgDaily14d: theme.debugCounts?.avgDaily14d || 0
      });

      // Prune: keep last 90 days only
      if (entries.length > 90) {
        entries.splice(0, entries.length - 90);
      }
    }
  }

  writeFileSync(historyPath, JSON.stringify(history, null, 2), "utf-8");

  themes.sort((a, b) => b.score - a.score);
  const allThemeData = themes.map(t => ({ name: t.name, articles: t.articles, riskTags: FIXED_TAXONOMY[t.name]?.riskTags || [] }));
  for (const t of themes) t.relatedThemes = computeRelatedThemes(t.name, allThemeData);
  return themes;
}

function buildMacroQuery(): string {
  const grouped = `(${QUERY_GROUPS.join(") OR (")})`;
  const full = `${grouped} ${EXCLUSIONS.join(" ")}`;
  if (full.length > 500) return `(${QUERY_GROUPS.slice(0, 4).join(") OR (")}) ${EXCLUSIONS.join(" ")}`;
  return full;
}

function isNoisy(title: string, description: string): boolean {
  const text = `${title} ${description}`.toLowerCase();
  return NOISE_WORDS.some((nw) => text.includes(nw));
}

function getFourteenDaysAgo(): string {
  const d = new Date();
  d.setDate(d.getDate() - 14);
  return d.toISOString().split("T")[0];
}

async function fetchNewsAPIPage(apiKey: string, query: string, page: number, fromDate: string): Promise<any[]> {
  const url = new URL("https://newsapi.org/v2/everything");
  url.searchParams.set("q", query);
  url.searchParams.set("sortBy", "publishedAt");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("page", String(page));
  url.searchParams.set("language", "en");
  url.searchParams.set("from", fromDate);
  url.searchParams.set("apiKey", apiKey);
  const res = await fetch(url.toString());
  if (!res.ok) { const body = await res.text(); throw new Error(`NewsAPI page ${page} returned ${res.status}: ${body}`); }
  const data = await res.json();
  if (data.status !== "ok") throw new Error(`NewsAPI error: ${data.message || "Unknown error"}`);
  return data.articles || [];
}

async function fetchFromNewsAPI(apiKey: string): Promise<{ articles: NewsArticle[]; debug: FetchDebug }> {
  const query = buildMacroQuery();
  const fromDate = getFourteenDaysAgo();
  const maxPages = 5;
  let allRaw: any[] = [];
  for (let page = 1; page <= maxPages; page++) {
    try {
      const pageArticles = await fetchNewsAPIPage(apiKey, query, page, fromDate);
      allRaw = allRaw.concat(pageArticles);
      if (pageArticles.length < 100) break;
    } catch (err: any) { console.error(`NewsAPI page ${page} failed:`, err.message); if (page === 1) throw err; break; }
  }
  const fetchedCount = allRaw.length;
  const seen = new Set<string>();
  const deduped = allRaw.filter((a: any) => {
    if (!a.title || a.title === "[Removed]") return false;
    const key = a.url || a.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const dedupedCount = deduped.length;
  const filtered = deduped.filter((a: any) => !isNoisy(a.title || "", a.description || ""));
  const filteredCount = filtered.length;
  const sourceCounts: Record<string, number> = {};
  for (const a of filtered) { const name = a.source?.name || "Unknown"; sourceCounts[name] = (sourceCounts[name] || 0) + 1; }
  const topSources = Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count }));
  const articles: NewsArticle[] = filtered.map((a: any, i: number) => ({
    id: `newsapi-${i}-${Date.now()}`,
    title: a.title || "",
    source: a.source?.name || "Unknown",
    publishedAt: a.publishedAt || new Date().toISOString(),
    url: a.url || "",
    description: a.description || "",
    imageUrl: a.urlToImage || "",
  }));
  return { articles, debug: { fetchedCount, dedupedCount, filteredCount, topSources, pagesRequested: Math.min(maxPages, Math.ceil(fetchedCount / 100) || 1), queryLength: query.length } };
}

async function fetchFromGDELT(): Promise<{ articles: NewsArticle[]; debug: FetchDebug }> {
  const query = QUERY_GROUPS[0];
  const url = `https://api.gdeltproject.org/api/v2/doc/doc?query=${encodeURIComponent(query)}&mode=ArtList&maxrecords=100&format=json&sort=DateDesc`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GDELT returned ${res.status}`);
  const data = await res.json();
  const raw = data.articles || [];
  const articles: NewsArticle[] = raw.map((a: any, i: number) => ({
    id: `gdelt-${i}-${Date.now()}`,
    title: a.title || "",
    source: a.domain || a.sourcecountry || "Unknown",
    publishedAt: a.seendate
      ? new Date(
          a.seendate.replace(
            /(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z/,
            "$1-$2-$3T$4:$5:$6Z",
          ),
        ).toISOString()
      : new Date().toISOString(),
    url: a.url || "",
    description: a.title || "",
    imageUrl: "",
  }));
  const sourceCounts: Record<string, number> = {};
  for (const a of articles) sourceCounts[a.source] = (sourceCounts[a.source] || 0) + 1;
  return { articles, debug: { fetchedCount: raw.length, dedupedCount: raw.length, filteredCount: articles.length, topSources: Object.entries(sourceCounts).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([name, count]) => ({ name, count })), pagesRequested: 1, queryLength: query.length } };
}

async function extractOgImage(url: string): Promise<string> {
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; MarketPulseDashboard/1.0)" },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return "";
    const html = await res.text();

    // 1. Open Graph image (highest priority)
    const ogMatch = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
    if (ogMatch?.[1]) return ogMatch[1];

    // 2. Twitter card image
    const twitterMatch = html.match(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i)
      || html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']twitter:image["']/i);
    if (twitterMatch?.[1]) return twitterMatch[1];

    // 3. Scan <img> tags in article body — pick largest by width attr or first with a real src
    const imgMatches = Array.from(html.matchAll(/<img[^>]+src=["']([^"']+)["'][^>]*>/gi));
    let bestSrc = "";
    let bestWidth = 0;
    for (const m of imgMatches) {
      const src = m[1];
      if (!src || src.startsWith("data:") || src.includes("logo") || src.includes("icon") || src.includes("avatar") || src.includes("pixel") || src.includes("tracking")) continue;
      const widthMatch = m[0].match(/width=["']?(\d+)/i);
      const w = widthMatch ? parseInt(widthMatch[1]) : 0;
      if (w > bestWidth || (!bestSrc && w === 0)) {
        bestWidth = w;
        bestSrc = src;
      }
    }
    if (bestSrc) {
      // Resolve relative URLs
      if (bestSrc.startsWith("//")) return `https:${bestSrc}`;
      if (bestSrc.startsWith("/")) {
        const base = new URL(url);
        return `${base.origin}${bestSrc}`;
      }
      return bestSrc;
    }
  } catch {
    // Timeout or fetch error — skip silently
  }
  return "";
}

async function fetchFromRSS(): Promise<{ articles: NewsArticle[]; debug: FetchDebug }> {
  const articles: NewsArticle[] = [];
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

  for (const feed of RSS_FEEDS) {
    try {
      const parsed = await rssParser.parseURL(feed.url);
      for (const item of parsed.items || []) {
        const pubDate = item.pubDate ? new Date(item.pubDate) : new Date();
        if (pubDate < fourteenDaysAgo) continue;

        // Also check media:content and media:thumbnail fields common in RSS
        const enclosureUrl =
          (item as any)?.enclosure?.url ||
          (item as any)?.enclosure?.link ||
          (item as any)?.["media:content"]?.["$"]?.url ||
          (item as any)?.["media:thumbnail"]?.["$"]?.url ||
          (item as any)?.image?.url ||
          (item as any)?.itunes?.image ||
          "";

        articles.push({
          id: `rss-${feed.source}-${item.guid || item.link || Date.now()}`,
          title: item.title || "",
          source: feed.source,
          publishedAt: pubDate.toISOString(),
          url: item.link || "",
          description: item.contentSnippet || item.content || item.title || "",
          imageUrl: enclosureUrl,
        });
      }
    } catch (err: any) {
      console.error(`RSS feed ${feed.source} failed:`, err.message);
    }
  }

  // Restore cached imageUrls from the articles DB to avoid re-scraping
  const cachedByUrl = new Map<string, string>();
  for (const stored of loadStoredArticles()) {
    if (stored.url && stored.imageUrl) cachedByUrl.set(stored.url, stored.imageUrl);
  }
  for (const a of articles) {
    if (!a.imageUrl && a.url && cachedByUrl.has(a.url)) {
      a.imageUrl = cachedByUrl.get(a.url)!;
    }
  }

  // Enrich articles still missing images by fetching OG metadata (batched, 5 concurrent)
  const missing = articles.filter(a => !a.imageUrl && a.url);
  const CONCURRENCY = 5;
  for (let i = 0; i < missing.length; i += CONCURRENCY) {
    const batch = missing.slice(i, i + CONCURRENCY);
    const images = await Promise.all(batch.map(a => extractOgImage(a.url)));
    for (let j = 0; j < batch.length; j++) {
      if (images[j]) batch[j].imageUrl = images[j];
    }
  }

  return { articles, debug: { fetchedCount: articles.length, dedupedCount: articles.length, filteredCount: articles.length, topSources: RSS_FEEDS.map(f => ({ name: f.source, count: articles.filter(a => a.source === f.source).length })), pagesRequested: RSS_FEEDS.length, queryLength: 0 } };
}

async function fetchMacroNews(): Promise<{ articles: NewsArticle[]; source: string; debug: FetchDebug }> {
  const apiKey = process.env.NEWS_API_KEY;
  let articles: NewsArticle[] = [];
  let source = "";
  let debug: FetchDebug = { fetchedCount: 0, dedupedCount: 0, filteredCount: 0, topSources: [], pagesRequested: 0, queryLength: 0 };

  // Try to fetch from RSS feeds (trusted sources)
  try {
    const rssResult = await fetchFromRSS();
    articles = rssResult.articles;
    source = "RSS";
    debug = rssResult.debug;
  } catch (err: any) {
    console.error("RSS feeds failed:", err.message);
    source = "RSS (failed)";
  }

  // Add NewsAPI or GDELT
  if (apiKey) {
    try {
      const result = await fetchFromNewsAPI(apiKey);
      articles = [...articles, ...result.articles];
      source += " + NewsAPI";
      debug.fetchedCount += result.debug.fetchedCount;
    }
    catch (err: any) {
      console.error("NewsAPI failed, falling back to GDELT:", err.message);
      try {
        const result = await fetchFromGDELT();
        articles = [...articles, ...result.articles];
        source += " + GDELT (fallback)";
        debug.fetchedCount += result.debug.fetchedCount;
      } catch (gdeltErr: any) {
        console.error("GDELT also failed:", gdeltErr.message);
      }
    }
  } else {
    try {
      const result = await fetchFromGDELT();
      articles = [...articles, ...result.articles];
      source += " + GDELT (no API key)";
      debug.fetchedCount += result.debug.fetchedCount;
    } catch (gdeltErr: any) {
      console.error("GDELT failed:", gdeltErr.message);
    }
  }

  // If we have no articles at all, throw an error
  if (articles.length === 0) {
    throw new Error("Failed to fetch articles from any source");
  }

  const currentStored = loadStoredArticles();
  const totalAfterMerge = new Set([...currentStored.map(a => a.url), ...articles.map(a => a.url)]).size;
  if (totalAfterMerge < 150) {
    console.log(`Only ${totalAfterMerge} articles after merge, backfilling from GDELT...`);
    try { const gdelt = await fetchFromGDELT(); articles = [...articles, ...gdelt.articles]; source += " + GDELT backfill"; debug.fetchedCount += gdelt.debug.fetchedCount; }
    catch (err: any) { console.error("GDELT backfill failed:", err.message); }
  }
  return { articles, source, debug: debug! };
}

interface Analogue { id: string; title: string; dateRange: string; themeTags: string[]; summary: string; outcomes: string[]; marketImpacts: string[]; }

function fallbackScore(analogue: Analogue, snapshotWords: Set<string>, themeTagSet: Set<string>): number {
  let tagOverlap = 0;
  for (const tag of analogue.themeTags) { if (themeTagSet.has(tag.toLowerCase())) tagOverlap++; }
  const tagScore = analogue.themeTags.length > 0 ? tagOverlap / analogue.themeTags.length : 0;
  const analogueText = `${analogue.title} ${analogue.summary} ${analogue.outcomes.join(" ")}`.toLowerCase().replace(/[^a-z0-9\s]/g, "");
  const analogueWords = analogueText.split(/\s+/).filter(w => w.length > 3);
  let kwOverlap = 0;
  for (const w of analogueWords) { if (snapshotWords.has(w)) kwOverlap++; }
  const kwScore = analogueWords.length > 0 ? Math.min(kwOverlap / Math.max(snapshotWords.size, 1), 1) : 0;
  return Math.min((tagScore * 60) + (kwScore * 40), 99);
}

async function fetchEarningsCalendar(): Promise<EarningsEvent[]> {
  const apiKey = process.env.FMP_API_KEY;
  if (!apiKey) {
    console.error("FMP_API_KEY not configured");
    return [];
  }

  try {
    const today = new Date();
    const from = today.toISOString().split('T')[0];
    const to = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const url = `https://financialmodelingprep.com/stable/earnings-calendar?apikey=${apiKey}&from=${from}&to=${to}`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`FMP API error: ${res.status}`);
    const data = await res.json();

    const topSymbols = new Set(TOP_COMPANIES.map(c => c.symbol));
    const filtered = data.filter((e: any) => topSymbols.has(e.symbol));

    return filtered.map((e: any) => ({
      company: TOP_COMPANIES.find(c => c.symbol === e.symbol)?.name || e.symbol,
      symbol: e.symbol,
      date: e.date,
      sector: TOP_COMPANIES.find(c => c.symbol === e.symbol)?.sector || "Other"
    })).sort((a, b) => a.date.localeCompare(b.date));
  } catch (err) {
    console.error("Failed to fetch earnings calendar:", err);
    return [];
  }
}

async function detectCorporateSignals(): Promise<CorporateSignal[]> {
  const articles = loadStoredArticles();
  const signals: CorporateSignal[] = [];

  for (const article of articles) {
    const text = `${article.title} ${article.description}`.toLowerCase();

    for (const company of TOP_COMPANIES) {
      const companyName = company.name.toLowerCase();
      const regex = new RegExp(`\\b${companyName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');

      if (regex.test(text)) {
        const sector = COMPANY_TO_SECTOR[companyName] || "Other";
        const sentiment = text.includes("beat") || text.includes("surge") || text.includes("strong") || text.includes("gain") || text.includes("rise") || text.includes("up") ? "positive" :
                         text.includes("miss") || text.includes("weak") || text.includes("decline") || text.includes("fall") || text.includes("down") || text.includes("loss") ? "negative" : "neutral";

        signals.push({
          company: company.name,
          ticker: company.symbol,
          articleTitle: article.title,
          sector: sector,
          signalSentiment: sentiment,
          timestamp: article.publishedAt
        });
        break;
      }
    }
  }

  return signals.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()).slice(0, 50);
}

const BACKFILL_FLAG_PATH = join(process.cwd(), "data", ".backfill_completed");
const BACKFILL_KEYWORDS = ["economy", "inflation", "interest rates", "central bank", "AI", "semiconductors", "oil", "energy", "geopolitics", "trade war", "recession", "GDP", "jobs report", "financial markets"];

async function runHistoricalBackfill(apiKey: string): Promise<void> {
  if (existsSync(BACKFILL_FLAG_PATH)) {
    console.log("Backfill already completed, skipping...");
    return;
  }

  console.log("Starting 14-day historical backfill...");
  const now = new Date();
  const fourteenDaysAgo = new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000);
  const fromDate = fourteenDaysAgo.toISOString().split("T")[0];
  const toDate = now.toISOString().split("T")[0];

  const existingArticles = loadStoredArticles();
  const existingUrls = new Set(existingArticles.map(a => a.url));
  let totalFetched = 0;
  let totalStored = 0;
  let totalSkipped = 0;

  for (const keyword of BACKFILL_KEYWORDS) {
    console.log(`Fetching keyword: ${keyword}`);
    let keywordArticles: NewsArticle[] = [];

    for (let page = 1; page <= 3; page++) {
      try {
        const url = new URL("https://newsapi.org/v2/everything");
        url.searchParams.set("q", keyword);
        url.searchParams.set("from", fromDate);
        url.searchParams.set("to", toDate);
        url.searchParams.set("sortBy", "publishedAt");
        url.searchParams.set("pageSize", "100");
        url.searchParams.set("page", String(page));
        url.searchParams.set("language", "en");
        url.searchParams.set("apiKey", apiKey);

        const res = await fetch(url.toString());
        if (!res.ok) {
          if (res.status === 429) {
            console.log(`  Rate limit reached. Backfill will resume when limit resets.`);
            writeFileSync(ARTICLES_DB_PATH, JSON.stringify(existingArticles, null, 2));
            writeFileSync(BACKFILL_FLAG_PATH, new Date().toISOString());
            return;
          }
          console.error(`  API returned ${res.status} for "${keyword}" page ${page}`);
          break;
        }
        const data = await res.json();
        if (data.status !== "ok") {
          console.error(`  API error for "${keyword}": ${data.message || "Unknown"}`);
          break;
        }
        if (!data.articles) break;

        totalFetched += data.articles.length;

        for (const a of data.articles) {
          if (!a.url || existingUrls.has(a.url)) {
            totalSkipped++;
            continue;
          }
          if (isNoisy(a.title || "", a.description || "")) continue;

          const article: NewsArticle = {
            id: `backfill-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
            title: a.title || "",
            source: a.source?.name || "Unknown",
            publishedAt: a.publishedAt || new Date().toISOString(),
            url: a.url,
            description: a.description || "",
            imageUrl: a.urlToImage || ""
          };

          keywordArticles.push(article);
          existingUrls.add(a.url);
        }

        if (data.articles.length < 100) break;
      } catch (err: any) {
        console.error(`Failed to fetch page ${page} for keyword "${keyword}":`, err.message);
        break;
      }
    }

    if (keywordArticles.length > 0) {
      const classified = keywordArticles.map(a => classifyArticle(a));
      existingArticles.push(...classified);
    }
    console.log(`  Stored ${keywordArticles.length} new articles for "${keyword}"`);
    totalStored += keywordArticles.length;
  }

  writeFileSync(ARTICLES_DB_PATH, JSON.stringify(existingArticles, null, 2));
  console.log(`Backfill completed: fetched ${totalFetched}, stored ${totalStored}, skipped ${totalSkipped}`);
  console.log(`Total articles in database: ${existingArticles.length}`);
  writeFileSync(BACKFILL_FLAG_PATH, new Date().toISOString());
}

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  if (process.env.NEWS_API_KEY) {
    runHistoricalBackfill(process.env.NEWS_API_KEY).catch(err => {
      console.error("Backfill failed:", err.message);
    });
  }

  // Auto-fetch RSS feeds every 15 minutes
  const autoFetch = async () => {
    try {
      console.log("Auto-fetching news articles...");
      const { articles } = await fetchMacroNews();
      const classified = articles.map(classifyArticle);
      addToHistory(classified);
      console.log(`Auto-fetch complete: ${classified.length} new articles stored`);
    } catch (err: any) {
      console.error("Auto-fetch failed:", err.message);
    }
  };

  autoFetch();
  setInterval(autoFetch, 15 * 60 * 1000);

  app.get("/api/health", (_req, res) => { res.json({ hasNewsKey: !!process.env.NEWS_API_KEY, hasFredKey: !!process.env.FRED_API_KEY }); });

  app.get("/api/news", async (_req, res) => {
    try {
      const { articles, source, debug } = await fetchMacroNews();
      res.json({ articles, source, fetchedAt: new Date().toISOString(), count: articles.length, debug });
    } catch (err: any) { console.error("Failed to fetch news:", err); res.status(500).json({ error: "Failed to fetch news articles", message: err.message || "An unexpected error occurred", articles: [] }); }
  });

  app.get("/api/refresh", async (req, res) => {
    try {
      const { articles, source, debug } = await fetchMacroNews();
      const classified = articles.map(classifyArticle);
      const storageDebug = addToHistory(classified);
      const allStored = loadStoredArticles();
      const themes = await groupByThemes(allStored);
      const isDebug = req.query.debug === "1";

      // Track signals for hot/warm themes
      const today = new Date().toISOString().split('T')[0];
      for (const theme of themes) {
        if (theme.score >= 60) {
          await storage.addSignalHistory({
            date: today,
            theme: theme.name,
            level: theme.heat.toUpperCase() as "HOT" | "WARM" | "COOL",
            score: theme.score
          });
        }
      }

      const response: any = { themes, source, fetchedAt: new Date().toISOString(), totalArticles: allStored.length, classifiedArticles: classified.length, themeCount: themes.length, taxonomy: TAXONOMY_NAMES, debug, storageDebug };
      if (isDebug) {
        response.debugSummary = { ...storageDebug, sampleThemeTimeseriesPreview: themes.slice(0, 3).map(t => ({ theme: t.name, articleCount: t.articles.length, timeseries: t.timeseries, timeseriesLength: t.timeseries.length, hasNonZero: t.timeseries.some(p => p.count > 0) })) };
      }
      console.log('[API RESPONSE] Sending theme scores:', themes.map(t => ({ name: t.name, score: t.score })));
      res.json(response);
    } catch (err: any) { console.error("Failed to refresh news:", err); res.status(500).json({ error: "Failed to refresh news articles", message: err.message || "An unexpected error occurred", themes: [] }); }
  });

  app.get("/api/market-timeseries", async (_req, res) => {
    try {
      const timeseries = await fetchMarketTimeseries();
      res.json({ timeseries, tickers: MARKET_TICKERS, fetchedAt: new Date().toISOString() });
    } catch (err: any) { console.error("Failed to fetch market timeseries:", err); res.status(500).json({ error: "Failed to fetch market timeseries", message: err.message }); }
  });

  app.get("/api/themes/history", async (req, res) => {
    try {
      const historyPath = join(process.cwd(), "data", "theme_history.json");
      const history: ThemeHistory = existsSync(historyPath)
        ? JSON.parse(readFileSync(historyPath, "utf-8"))
        : {};

      const themeName = req.query.theme as string | undefined;

      if (themeName) {
        res.json({ [themeName]: history[themeName] || [] });
      } else {
        res.json(history);
      }
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch theme history", message: err.message });
    }
  });

  app.get("/api/themes/previous-scores", async (_req, res) => {
    try {
      const scoresPath = join(process.cwd(), "data", "theme_scores.json");
      const previousScores = existsSync(scoresPath)
        ? JSON.parse(readFileSync(scoresPath, "utf-8"))
        : {};
      res.json(previousScores);
    } catch (err: any) {
      res.status(500).json({ error: "Failed to fetch previous scores", message: err.message });
    }
  });

  app.post("/api/historical-analogues", async (req, res) => {
    try {
      const { themeName, articleTitles = [], themeTags = [] } = req.body;
      if (!themeName) return res.status(400).json({ error: "themeName is required" });
      const analoguesPath = join(process.cwd(), "data", "analogues.json");
      const analogues: Analogue[] = JSON.parse(readFileSync(analoguesPath, "utf-8"));
      const snapshot = articleTitles.slice(0, 5).join(". ");
      const snapshotWords = new Set(snapshot.toLowerCase().replace(/[^a-z0-9\s]/g, "").split(/\s+/).filter(w => w.length > 3));
      const themeTagSet = new Set(themeTags.map((t: string) => t.toLowerCase()));
      const scored = analogues.map(analogue => ({ ...analogue, similarity: Math.round(fallbackScore(analogue, snapshotWords, themeTagSet)) }));
      scored.sort((a, b) => b.similarity - a.similarity);
      res.json({ analogues: scored.slice(0, 5), method: "fallback" });
    } catch (err: any) { console.error("Failed to get historical analogues:", err); res.status(500).json({ error: "Failed to retrieve historical analogues" }); }
  });

  const milestonesCache = new Map<string, { data: { narrative: string; milestones: string[] }; expiresAt: number }>();

  app.post("/api/milestones", async (req, res) => {
    try {
      const { themeId, themeName, articles } = req.body as { themeId: string; themeName: string; articles: { title: string; description: string; source: string; publishedAt: string }[] };
      if (!themeId || !themeName || !articles?.length) return res.status(400).json({ error: "themeId, themeName, and articles are required" });
      const cached = milestonesCache.get(themeId);
      if (cached && Date.now() < cached.expiresAt) return res.json(cached.data);

      const topArticles = articles.slice(0, 10);
      const articleList = topArticles.map((a, i) => `${i + 1}. "${a.title}" (${a.source})${a.description ? ` — ${a.description.slice(0, 100)}` : ""}`).join("\n");

      const prompt = `You are a macro risk analyst. Given these recent articles for the theme "${themeName}", produce a concise summary.\n\nArticles:\n${articleList}\n\nRules:\n- Output ONLY valid JSON, no markdown, no code blocks.\n- narrative: exactly 1 sentence, max 20 words, describing the current state of this theme.\n- milestones: 3 to 5 bullet strings, each max 12 words, written as clean event-style milestones.\n- Use neutral macro language (e.g. "Escalation", "Sanctions risk", "Risk-off flows").\n- No ellipses, no direct headline quotes, no publisher names.\n- Each milestone should capture a distinct development or shift.\n\nRespond with exactly:\n{"narrative":"...","milestones":["...","...","..."]}`;

      // ── Groq API call ──
      const groqResult = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 500 });
      const content = groqResult.choices[0]?.message?.content || "";

      let parsed;
      try { parsed = JSON.parse(content); }
      catch { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error("AI response was not valid JSON"); }

      const result = { narrative: parsed.narrative || "", milestones: (parsed.milestones || []).slice(0, 5) };
      milestonesCache.set(themeId, { data: result, expiresAt: Date.now() + 10 * 60 * 1000 });
      res.json(result);
    } catch (err: any) { console.error("Failed to generate milestones:", err); res.status(500).json({ error: "Failed to generate milestones", message: err.message }); }
  });

  const implicationsCache = new Map<string, { data: { implications: string[] }; expiresAt: number }>();

  app.post("/api/business-implications", async (req, res) => {
    try {
      const { themeId, themeName, articles } = req.body as { themeId: string; themeName: string; articles: { title: string; description: string; source: string }[] };
      if (!themeId || !themeName || !articles?.length) return res.status(400).json({ error: "themeId, themeName, and articles are required" });
      const cached = implicationsCache.get(themeId);
      if (cached && Date.now() < cached.expiresAt) return res.json(cached.data);

      const topArticles = articles.slice(0, 8);
      const articleList = topArticles.map((a, i) => `${i + 1}. "${a.title}"${a.description ? ` — ${a.description.slice(0, 80)}` : ""}`).join("\n");

      const prompt = `You are a senior business strategist. Given these recent news articles about the macro theme "${themeName}", identify the key business implications for companies and investors.\n\nArticles:\n${articleList}\n\nRules:\n- Output ONLY valid JSON, no markdown, no code blocks.\n- implications: exactly 4 strings, each max 15 words.\n- Each implication must be a distinct, actionable business insight (e.g. sector impact, cost pressure, opportunity, risk).\n- Write in active voice. Start each with a verb or sector name.\n- No ellipses, no publisher names, no direct quotes.\n\nRespond with exactly:\n{"implications":["...","...","...","..."]}`;

      const groqResult = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 300 });
      const content = groqResult.choices[0]?.message?.content || "";

      let parsed;
      try { parsed = JSON.parse(content); }
      catch { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error("AI response was not valid JSON"); }

      const result = { implications: (parsed.implications || []).slice(0, 4) };
      implicationsCache.set(themeId, { data: result, expiresAt: Date.now() + 10 * 60 * 1000 });
      res.json(result);
    } catch (err: any) { console.error("Failed to generate business implications:", err); res.status(500).json({ error: "Failed to generate business implications", message: err.message }); }
  });

  app.post("/api/explain-today", async (req, res) => {
    try {
      const { themes } = req.body as { themes: ThemeGroup[] };
      if (!themes || !Array.isArray(themes)) return res.status(400).json({ error: "themes array is required" });

      const hotThemes = themes.filter(t => t.heat === "hot").sort((a, b) => b.score - a.score);
      const topThemes = hotThemes.length > 0 ? hotThemes : themes.slice(0, 3);

      const topArticles: { theme: string; title: string; source: string }[] = [];
      for (const theme of topThemes.slice(0, 5)) {
        const sorted = [...theme.articles].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        for (const a of sorted.slice(0, 3)) {
          topArticles.push({ theme: theme.name, title: a.title, source: a.source });
          if (topArticles.length >= 12) break;
        }
        if (topArticles.length >= 12) break;
      }

      const articleList = topArticles.map((a, i) => `${i + 1}. [${a.theme}] "${a.title}" (${a.source})`).join("\n");
      const themeList = topThemes.slice(0, 5).map(t => `- ${t.name} (heat: ${t.heat}, score: ${t.score})`).join("\n");

      const prompt = `You are a macro risk analyst. Given today's top themes and articles, provide a concise daily briefing.\n\nActive HOT themes:\n${themeList}\n\nTop articles:\n${articleList}\n\nRespond with EXACTLY this JSON format (no markdown, no code blocks):\n{\n  "bullets": [\n    "First key insight about today's macro landscape (1-2 sentences)",\n    "Second key insight connecting themes or highlighting risk (1-2 sentences)",\n    "Third key insight about what to watch next (1-2 sentences)"\n  ],\n  "causalChain": [\n    "Root cause or trigger event",\n    "First-order market effect",\n    "Second-order consequence",\n    "Portfolio or positioning implication"\n  ]\n}`;

      // ── Groq API call ──
      const groqResult = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 800 });
      const content = groqResult.choices[0]?.message?.content || "";

      let parsed;
      try { parsed = JSON.parse(content); }
      catch { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error("AI response was not valid JSON"); }

      res.json({ bullets: parsed.bullets || [], causalChain: parsed.causalChain || [], generatedAt: new Date().toISOString() });
    } catch (err: any) { console.error("Failed to generate explanation:", err); res.status(500).json({ error: "Failed to generate explanation", message: err.message || "An unexpected error occurred" }); }
  });

  const summaryCache = new Map<string, { data: { bullets: string[]; causalChain: string[]; generatedAt: string }; expiresAt: number }>();

  app.post("/api/summary", async (req, res) => {
    try {
      const { themes, period } = req.body as { themes: ThemeGroup[]; period: "today" | "week" | "month" };
      if (!themes || !Array.isArray(themes) || !period) return res.status(400).json({ error: "themes and period are required" });

      const cacheKey = `${period}-${themes.map(t => t.id).join(",")}`;
      const cached = summaryCache.get(cacheKey);
      if (cached && Date.now() < cached.expiresAt) return res.json(cached.data);

      // Filter articles by period
      const now = Date.now();
      const cutoffMs = period === "today" ? 24 * 60 * 60 * 1000 : period === "week" ? 7 * 24 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000;
      const cutoff = new Date(now - cutoffMs);
      const periodLabel = period === "today" ? "today" : period === "week" ? "this week" : "this month";

      const filteredThemes = themes.map(t => ({
        ...t,
        articles: t.articles.filter(a => new Date(a.publishedAt) >= cutoff),
      })).filter(t => t.articles.length > 0);

      const topThemes = (filteredThemes.filter(t => t.heat === "hot").length > 0
        ? filteredThemes.filter(t => t.heat === "hot")
        : filteredThemes
      ).sort((a, b) => b.score - a.score).slice(0, 5);

      if (topThemes.length === 0) return res.json({ bullets: [], causalChain: [], generatedAt: new Date().toISOString() });

      const topArticles: { theme: string; title: string; source: string }[] = [];
      for (const theme of topThemes) {
        const sorted = [...theme.articles].sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
        for (const a of sorted.slice(0, 3)) {
          topArticles.push({ theme: theme.name, title: a.title, source: a.source });
          if (topArticles.length >= 15) break;
        }
        if (topArticles.length >= 15) break;
      }

      const articleList = topArticles.map((a, i) => `${i + 1}. [${a.theme}] "${a.title}" (${a.source})`).join("\n");
      const themeList = topThemes.map(t => `- ${t.name} (heat: ${t.heat}, score: ${t.score}, articles: ${t.articles.length})`).join("\n");

      const prompt = `You are a macro risk analyst. Summarize the macro landscape for ${periodLabel} based on the themes and articles below.\n\nActive themes ${periodLabel}:\n${themeList}\n\nTop articles:\n${articleList}\n\nRespond with EXACTLY this JSON format (no markdown, no code blocks):\n{\n  "bullets": [\n    "First key insight about the macro landscape ${periodLabel} (1-2 sentences)",\n    "Second key insight connecting themes or highlighting risk (1-2 sentences)",\n    "Third key insight about what to watch next (1-2 sentences)"\n  ],\n  "causalChain": [\n    "Root cause or trigger event",\n    "First-order market effect",\n    "Second-order consequence",\n    "Portfolio or positioning implication"\n  ]\n}`;

      const groqResult = await groq.chat.completions.create({ model: "llama-3.3-70b-versatile", messages: [{ role: "user", content: prompt }], max_tokens: 800 });
      const content = groqResult.choices[0]?.message?.content || "";

      let parsed;
      try { parsed = JSON.parse(content); }
      catch { const m = content.match(/\{[\s\S]*\}/); if (m) parsed = JSON.parse(m[0]); else throw new Error("AI response was not valid JSON"); }

      const result = { bullets: parsed.bullets || [], causalChain: parsed.causalChain || [], generatedAt: new Date().toISOString() };
      const ttl = period === "today" ? 15 * 60 * 1000 : period === "week" ? 60 * 60 * 1000 : 3 * 60 * 60 * 1000;
      summaryCache.set(cacheKey, { data: result, expiresAt: Date.now() + ttl });
      res.json(result);
    } catch (err: any) { console.error("Failed to generate summary:", err); res.status(500).json({ error: "Failed to generate summary", message: err.message || "An unexpected error occurred" }); }
  });

  app.get("/api/economic-indicators", async (_req, res) => {
    try {
      const sections = await fetchEconomicIndicators();
      res.json({ sections, fetchedAt: new Date().toISOString() });
    } catch (err: any) { console.error("Failed to fetch economic indicators:", err); res.status(500).json({ error: "Failed to fetch economic indicators", message: err.message }); }
  });

  app.get("/api/articles", async (_req, res) => {
    try {
      const articles = loadStoredArticles();
      articles.sort((a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime());
      res.json({ articles, count: articles.length, fetchedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error("Failed to fetch stored articles:", err);
      res.status(500).json({ error: "Failed to fetch stored articles", message: err.message });
    }
  });

  app.get("/api/countries/intelligence", async (_req, res) => {
    try {
      const articles = loadStoredArticles();
      const now = Date.now();
      const recentArticles = articles.filter(a => now - new Date(a.publishedAt).getTime() < 7 * 86400000);

      const MACRO_THEMES = ["Inflation", "Monetary Policy", "Fiscal Policy", "Geopolitics & Conflicts",
        "Energy & Commodities", "China Economy", "Banking & Credit", "Currency & FX", "Trade & Tariffs"];

      const countryData: Record<string, any> = {};

      recentArticles.forEach(article => {
        if (!MACRO_THEMES.includes(article.theme)) return;

        const countries = extractCountries(`${article.title} ${article.description}`);
        countries.forEach(code => {
          if (!countryData[code]) {
            countryData[code] = { articles: [], themes: {}, recentCount: 0, oldCount: 0 };
          }
          countryData[code].articles.push(article);
          countryData[code].themes[article.theme] = (countryData[code].themes[article.theme] || 0) + 1;

          const age = now - new Date(article.publishedAt).getTime();
          if (age < 3 * 86400000) countryData[code].recentCount++;
          else countryData[code].oldCount++;
        });
      });

      const countries = Object.entries(countryData).map(([code, data]: [string, any]) => {
        const articleVolume = Math.min(data.articles.length / 20, 1) * 50;
        const momentum = data.recentCount > data.oldCount ? 30 : data.recentCount === data.oldCount ? 15 : 0;
        const topTheme = Object.entries(data.themes).sort((a: any, b: any) => b[1] - a[1])[0];
        const themeHeat = topTheme ? Math.min((topTheme[1] as number) / 10, 1) * 20 : 0;

        const intensity = Math.min(articleVolume + momentum + themeHeat, 100);

        return {
          code,
          intensity: Math.round(intensity),
          articleCount: data.articles.length,
          topTheme: topTheme ? topTheme[0] : "Unknown",
          articles: data.articles.slice(0, 20).map((a: any) => ({
            id: a.id, title: a.title, source: a.source, publishedAt: a.publishedAt,
            url: a.url, theme: a.theme, description: a.description
          })),
          themes: Object.entries(data.themes).sort((a: any, b: any) => b[1] - a[1]).slice(0, 5)
        };
      });

      res.json({ countries, fetchedAt: new Date().toISOString() });
    } catch (err: any) {
      console.error("Failed to fetch country intelligence:", err);
      res.status(500).json({ error: "Failed to fetch country intelligence", message: err.message });
    }
  });

  app.post("/api/countries/:code/summary", async (req, res) => {
    try {
      const { code } = req.params;
      const articles = loadStoredArticles();
      const now = Date.now();
      const recentArticles = articles
        .filter(a => now - new Date(a.publishedAt).getTime() < 7 * 86400000)
        .filter(a => extractCountries(`${a.title} ${a.description}`).includes(code))
        .slice(0, 15);

      if (recentArticles.length === 0) {
        return res.json({ summary: "No recent developments.", causalChain: [] });
      }

      const context = recentArticles.map(a => `- ${a.title}`).join("\n");
      const prompt = `Based on these recent news headlines about ${code}, provide a 2-3 sentence intelligence summary of what is happening:\n\n${context}\n\nSummary:`;

      const completion = await groq.chat.completions.create({
        model: "llama-3.3-70b-versatile",
        messages: [{ role: "user", content: prompt }],
        temperature: 0.3,
        max_tokens: 200
      });

      const summary = completion.choices[0]?.message?.content?.trim() || "Unable to generate summary.";
      res.json({ summary, articleCount: recentArticles.length });
    } catch (err: any) {
      console.error("Failed to generate country summary:", err);
      res.status(500).json({ error: "Failed to generate summary", message: err.message });
    }
  });

  app.get("/api/sectors/overview", async (_req, res) => {
    try {
      const articlesPath = join(process.cwd(), "data", "articles.json");
      const articles: ClassifiedArticle[] = existsSync(articlesPath) ? JSON.parse(readFileSync(articlesPath, "utf-8")) : [];
      res.json({ articles: articles.map(a => ({ id: a.id, title: a.title, description: a.description })), fetchedAt: new Date().toISOString() });
    } catch (err: any) { console.error("Failed to fetch sector overview:", err); res.status(500).json({ error: "Failed to fetch sector overview", message: err.message }); }
  });

  app.get("/api/sectors/:sector/news", async (req, res) => {
    try {
      const { sector } = req.params;
      const articlesPath = join(process.cwd(), "data", "articles.json");
      const articles: ClassifiedArticle[] = existsSync(articlesPath) ? JSON.parse(readFileSync(articlesPath, "utf-8")) : [];
      res.json({ articles: articles.map(a => ({ id: a.id, title: a.title, description: a.description, source: a.source, publishedAt: a.publishedAt, url: a.url })), sector, fetchedAt: new Date().toISOString() });
    } catch (err: any) { console.error("Failed to fetch sector news:", err); res.status(500).json({ error: "Failed to fetch sector news", message: err.message }); }
  });

  app.get("/api/sectors/heatmap", async (_req, res) => {
    try {
      const articlesPath = join(process.cwd(), "data", "articles.json");
      const articles: ClassifiedArticle[] = existsSync(articlesPath) ? JSON.parse(readFileSync(articlesPath, "utf-8")) : [];
      res.json({ articles: articles.map(a => ({ id: a.id, title: a.title, description: a.description })), fetchedAt: new Date().toISOString() });
    } catch (err: any) { console.error("Failed to fetch sector heatmap:", err); res.status(500).json({ error: "Failed to fetch sector heatmap", message: err.message }); }
  });

  app.get("/api/workspace/notes", async (_req, res) => {
    try {
      const notes = await storage.getNotes();
      res.json(notes);
    } catch (err: any) { res.status(500).json({ error: "Failed to fetch notes", message: err.message }); }
  });

  app.post("/api/workspace/notes", async (req, res) => {
    try {
      const { title, description, pinned, keywords } = req.body;
      const extractedKeywords = keywords || extractKeywordsFromText(description);
      const note = await storage.createNote({ title, description, createdAt: new Date().toISOString(), pinned: pinned || false, keywords: extractedKeywords });
      res.json(note);
    } catch (err: any) { res.status(500).json({ error: "Failed to create note", message: err.message }); }
  });

  app.patch("/api/workspace/notes/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const updates = req.body;
      const note = await storage.updateNote(id, updates);
      if (!note) return res.status(404).json({ error: "Note not found" });
      res.json(note);
    } catch (err: any) { res.status(500).json({ error: "Failed to update note", message: err.message }); }
  });

  app.delete("/api/workspace/notes/:id", async (req, res) => {
    try {
      const { id } = req.params;
      const deleted = await storage.deleteNote(id);
      if (!deleted) return res.status(404).json({ error: "Note not found" });
      res.json({ success: true });
    } catch (err: any) { res.status(500).json({ error: "Failed to delete note", message: err.message }); }
  });

  // Corporate Signals endpoints
  app.get("/api/earnings-calendar", async (_req, res) => {
    try {
      const calendar = await fetchEarningsCalendar();
      res.json({ events: calendar, fetchedAt: new Date().toISOString() });
    } catch (err: any) { res.status(500).json({ error: "Failed to fetch earnings calendar", message: err.message }); }
  });

  app.get("/api/corporate-signals", async (_req, res) => {
    try {
      const signals = await detectCorporateSignals();
      res.json({ signals, fetchedAt: new Date().toISOString() });
    } catch (err: any) { res.status(500).json({ error: "Failed to fetch corporate signals", message: err.message }); }
  });

  app.post("/api/workspace/risk-signals", async (req, res) => {
    try {
      const { noteId } = req.body;
      const notes = await storage.getNotes();
      const note = notes.find(n => n.id === noteId);
      if (!note) return res.status(404).json({ error: "Note not found" });

      const articlesPath = join(process.cwd(), "data", "articles.json");
      const articles: ClassifiedArticle[] = existsSync(articlesPath) ? JSON.parse(readFileSync(articlesPath, "utf-8")) : [];

      const relatedArticles = articles.filter(article => {
        const text = `${article.title} ${article.description}`.toLowerCase();
        return note.keywords.some(kw => text.includes(kw.toLowerCase()));
      }).slice(0, 10);

      res.json({ noteId, relatedArticles });
    } catch (err: any) { res.status(500).json({ error: "Failed to fetch risk signals", message: err.message }); }
  });

  app.post("/api/workspace/historical-analogues", async (req, res) => {
    try {
      const { noteId } = req.body;
      const notes = await storage.getNotes();
      const note = notes.find(n => n.id === noteId);
      if (!note) return res.status(404).json({ error: "Note not found" });

      const historicalEvents: HistoricalEvent[] = [
        { year: "2008", name: "Global Financial Crisis", description: "Lehman collapse, credit freeze, global recession", drivers: ["credit_crisis", "banking_collapse", "leverage", "subprime"], macroOutcomes: ["deep_recession", "deflation_risk", "credit_freeze"], marketImpact: ["equity_crash", "credit_freeze", "flight_to_quality"] },
        { year: "2011", name: "European Sovereign Debt Crisis", description: "Eurozone crisis threatens stability", drivers: ["sovereign_debt", "banking_crisis", "fiscal", "greece"], macroOutcomes: ["recession", "contagion", "austerity"], marketImpact: ["equity_selloff", "credit_spread_widening", "safe_haven_bid"] },
        { year: "1997", name: "Asian Financial Crisis", description: "Currency collapse across Asia, IMF bailouts", drivers: ["currency_collapse", "capital_flight", "debt"], macroOutcomes: ["recession", "imf_bailout", "contagion"], marketImpact: ["fx_collapse", "equity_crash", "em_stress"] },
        { year: "1998", name: "Russian Financial Crisis", description: "Debt default, ruble collapse", drivers: ["debt_default", "currency_collapse", "oil_price"], macroOutcomes: ["recession", "contagion", "capital_flight"], marketImpact: ["em_selloff", "ruble_collapse", "credit_stress"] },
        { year: "1990", name: "Japanese Asset Bubble Collapse", description: "Property and equity bubble burst, lost decade", drivers: ["asset_bubble", "monetary_tightening"], macroOutcomes: ["deflation", "lost_decade", "banking_crisis"], marketImpact: ["equity_crash", "property_collapse", "yen_strength"] },
        { year: "1987", name: "Black Monday Crash", description: "Global equity markets crash", drivers: ["program_trading", "overvaluation", "liquidity"], macroOutcomes: ["market_panic", "volatility_spike"], marketImpact: ["equity_crash", "global_contagion", "volatility"] },
        { year: "1973", name: "First Oil Crisis", description: "OPEC embargo drives oil up 400%", drivers: ["opec_embargo", "supply_shock", "geopolitical"], macroOutcomes: ["stagflation", "inflation_surge", "recession"], marketImpact: ["oil_spike", "equity_selloff", "commodity_surge"] },
        { year: "1979", name: "Second Oil Shock", description: "Iran revolution disrupts oil supply", drivers: ["iran_revolution", "supply_shock", "geopolitical"], macroOutcomes: ["stagflation", "inflation_surge"], marketImpact: ["oil_spike", "bond_yield_surge", "equity_pressure"] },
        { year: "1980", name: "Volcker Interest Rate Shock", description: "Fed raises rates to 20% to crush inflation", drivers: ["monetary_policy", "aggressive_tightening"], macroOutcomes: ["recession", "inflation_control", "unemployment"], marketImpact: ["bond_selloff", "dollar_surge", "equity_pressure"] },
        { year: "2021-2022", name: "Global Inflation Surge", description: "Supply chain disruptions drive inflation to 40-year highs", drivers: ["supply_chain", "stimulus", "energy_shock"], macroOutcomes: ["high_inflation", "monetary_tightening"], marketImpact: ["bond_selloff", "equity_volatility", "dollar_strength"] },
        { year: "1994", name: "Bond Market Crash", description: "Sudden Fed rate hikes trigger bond losses", drivers: ["monetary_policy", "rate_hikes"], macroOutcomes: ["bond_losses", "volatility"], marketImpact: ["bond_selloff", "yield_spike", "em_pressure"] },
        { year: "2013", name: "Taper Tantrum", description: "Fed signals taper, EMFX collapses", drivers: ["monetary_policy", "fed", "taper"], macroOutcomes: ["em_stress", "yield_spike", "capital_outflow"], marketImpact: ["bond_selloff", "em_fx_collapse", "equity_pressure"] },
        { year: "2022", name: "Energy Crisis", description: "Russia-Ukraine war drives oil to $130", drivers: ["supply_shock", "geopolitical", "energy", "oil", "russia", "ukraine"], macroOutcomes: ["high_inflation", "growth_slowdown", "recession_risk"], marketImpact: ["equity_volatility", "commodity_surge", "bond_yield_spike"] },
        { year: "2014", name: "Oil Price Collapse", description: "Shale boom and OPEC oversupply crash oil", drivers: ["supply_glut", "shale", "opec"], macroOutcomes: ["deflation_risk", "em_stress"], marketImpact: ["oil_collapse", "energy_equity_selloff", "em_fx_pressure"] },
        { year: "2020", name: "Oil Price Crash", description: "COVID demand collapse drives oil negative", drivers: ["demand_collapse", "storage_shortage", "pandemic"], macroOutcomes: ["deflation_risk", "energy_sector_stress"], marketImpact: ["oil_negative", "energy_bankruptcy", "volatility"] },
        { year: "2007-2008", name: "Commodity Supercycle Peak", description: "China demand drives commodities to records", drivers: ["china_demand", "supply_constraints"], macroOutcomes: ["inflation_pressure", "em_boom"], marketImpact: ["commodity_surge", "em_equity_rally", "inflation"] },
        { year: "2020", name: "COVID-19 Pandemic", description: "Global lockdowns, supply chain disruption", drivers: ["pandemic", "lockdown", "health_crisis"], macroOutcomes: ["recession", "stimulus", "supply_disruption"], marketImpact: ["equity_crash_recovery", "bond_yield_collapse", "volatility_spike"] },
        { year: "2000-2002", name: "Dot-Com Crash", description: "Tech bubble bursts, Nasdaq crashes 78%", drivers: ["tech_bubble", "overvaluation"], macroOutcomes: ["recession", "tech_sector_collapse"], marketImpact: ["nasdaq_crash", "equity_selloff", "flight_to_quality"] },
        { year: "1992", name: "Black Wednesday", description: "UK pound forced out of ERM", drivers: ["currency_speculation", "monetary_policy"], macroOutcomes: ["currency_crisis", "policy_shift"], marketImpact: ["pound_collapse", "bond_volatility"] },
        { year: "2015", name: "Chinese Yuan Devaluation", description: "China devalues yuan, triggers capital outflows", drivers: ["currency_policy", "capital_flight"], macroOutcomes: ["em_stress", "deflation_risk"], marketImpact: ["yuan_devaluation", "em_selloff", "commodity_pressure"] },
        { year: "2001", name: "China WTO Entry", description: "China joins WTO, accelerates globalization", drivers: ["trade_policy", "globalization"], macroOutcomes: ["global_growth", "deflation_pressure"], marketImpact: ["commodity_demand", "manufacturing_shift", "em_growth"] },
        { year: "2015", name: "China Stock Market Crash", description: "Chinese equity bubble bursts", drivers: ["equity_bubble", "leverage", "policy"], macroOutcomes: ["wealth_destruction", "growth_concerns"], marketImpact: ["china_equity_crash", "global_contagion", "commodity_selloff"] },
        { year: "2021", name: "China Property Crisis", description: "Evergrande default threatens property sector", drivers: ["property_bubble", "debt", "policy_tightening"], macroOutcomes: ["growth_slowdown", "deflation_risk"], marketImpact: ["property_selloff", "credit_stress", "commodity_pressure"] },
        { year: "2023", name: "China Deflation Concerns", description: "Weak demand drives deflation fears", drivers: ["weak_demand", "property_crisis"], macroOutcomes: ["deflation", "growth_slowdown"], marketImpact: ["yuan_weakness", "commodity_pressure", "equity_concerns"] },
        { year: "2001", name: "September 11 Attacks", description: "Terrorist attacks trigger market closure", drivers: ["geopolitical", "terrorism"], macroOutcomes: ["recession_risk", "policy_easing"], marketImpact: ["equity_selloff", "flight_to_quality", "volatility"] },
        { year: "2018", name: "US-China Trade War", description: "Tariffs disrupt supply chains", drivers: ["trade_policy", "geopolitical", "tariff"], macroOutcomes: ["supply_disruption", "growth_slowdown", "uncertainty"], marketImpact: ["equity_volatility", "safe_haven_flows", "fx_pressure"] },
        { year: "2020-2022", name: "COVID Supply Chain Crisis", description: "Pandemic disrupts global supply chains", drivers: ["pandemic", "lockdown", "logistics"], macroOutcomes: ["inflation", "shortages"], marketImpact: ["commodity_surge", "freight_costs", "equity_volatility"] },
        { year: "2021", name: "Global Semiconductor Shortage", description: "Chip shortage disrupts manufacturing", drivers: ["supply_constraint", "demand_surge"], macroOutcomes: ["production_delays", "inflation"], marketImpact: ["tech_equity_pressure", "auto_sector_stress"] },
        { year: "2017", name: "Crypto Boom", description: "Bitcoin surges to $20k", drivers: ["speculation", "tech_innovation"], macroOutcomes: ["asset_bubble", "volatility"], marketImpact: ["crypto_surge", "speculation"] },
        { year: "2022", name: "Crypto Collapse", description: "Terra Luna collapse, FTX bankruptcy", drivers: ["leverage", "fraud", "contagion"], macroOutcomes: ["wealth_destruction", "regulation"], marketImpact: ["crypto_crash", "contagion", "risk_off"] },
        { year: "2023", name: "Silicon Valley Bank Collapse", description: "Bank run triggers regional banking crisis", drivers: ["interest_rate_risk", "deposit_flight"], macroOutcomes: ["banking_stress", "credit_tightening"], marketImpact: ["bank_equity_selloff", "credit_stress", "flight_to_quality"] },
        { year: "2013", name: "Japan Abenomics Launch", description: "Aggressive monetary and fiscal stimulus", drivers: ["monetary_policy", "fiscal_stimulus"], macroOutcomes: ["reflation", "yen_weakness"], marketImpact: ["yen_devaluation", "equity_rally", "bond_buying"] },
        { year: "2009-2019", name: "Global QE Era", description: "Central banks launch unprecedented stimulus", drivers: ["monetary_policy", "qe", "crisis_response"], macroOutcomes: ["asset_inflation", "low_rates"], marketImpact: ["equity_rally", "bond_rally", "dollar_weakness"] },
        { year: "2022", name: "End of Zero Interest Rate Policy", description: "Central banks aggressively hike rates", drivers: ["monetary_policy", "inflation_control"], macroOutcomes: ["tightening", "recession_risk"], marketImpact: ["bond_selloff", "equity_pressure", "dollar_strength"] }
      ];

      // Generate note embedding
      const noteText = `${note.title} ${note.description} ${note.keywords.join(" ")}`;
      const noteEmbedding = await getEmbedding(noteText);

      // Generate event embeddings if not cached
      if (!historicalEvents[0].embedding) {
        for (const event of historicalEvents) {
          const eventText = `${event.name} ${event.description} ${event.drivers.join(" ")} ${event.macroOutcomes.join(" ")}`;
          event.embedding = await getEmbedding(eventText);
        }
      }

      // Calculate combined scores
      const analogues = historicalEvents.map(event => {
        const embeddingSim = cosineSimilarity(noteEmbedding, event.embedding!);
        const macroSim = macroFeatureMatch(note.keywords, event);
        const marketSim = marketImpactSimilarity(note.keywords, event);

        const similarity = Math.round((0.3 * embeddingSim + 0.2 * macroSim + 0.5 * marketSim) * 100);

        return { ...event, similarity, embedding: undefined };
      }).filter(e => e.similarity > 30).sort((a, b) => b.similarity - a.similarity).slice(0, 3);

      res.json({ noteId, analogues });
    } catch (err: any) {
      console.error("Historical analogues error:", err);
      res.status(500).json({ error: "Failed to fetch historical analogues", message: err.message });
    }
  });

  app.get("/api/signal-history", async (_req, res) => {
    try {
      const history = await storage.getSignalHistory();
      res.json(history);
    } catch (err: any) { res.status(500).json({ error: "Failed to fetch signal history", message: err.message }); }
  });

  app.post("/api/risk-implications", async (req, res) => {
    try {
      const { themeName, articles } = req.body;
      if (!themeName || !articles || !Array.isArray(articles)) {
        return res.status(400).json({ error: "themeName and articles array required" });
      }

      // Get top 5 recent articles for context
      const topArticles = articles.slice(0, 5).map(a => `- ${a.title} (${a.source})`).join("\n");

      const prompt = `You are a macro risk analyst. Given the theme "${themeName}" and recent news, generate a causal chain showing how this macro event cascades through markets.

Recent news:
${topArticles}

Respond with EXACTLY this JSON format (no markdown, no code blocks):
{
  "causalChain": [
    "Root cause or trigger event (based on news)",
    "First-order market effect",
    "Second-order consequence",
    "Portfolio or positioning implication"
  ],
  "riskTags": ["Asset1", "Asset2", "Asset3"]
}

Risk tags must be from: Rates, Equities, FX, Commodities, Energy, Technology, Credit, Emerging Markets, Growth Stocks, Value Stocks, Duration Risk, Inflation, Volatility`;

      const groqResult = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 500
      });

      const content = groqResult.choices[0]?.message?.content || "";
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
        else throw new Error("AI response was not valid JSON");
      }

      res.json({
        causalChain: parsed.causalChain || [],
        riskTags: parsed.riskTags || [],
        generatedAt: new Date().toISOString()
      });
    } catch (err: any) {
      console.error("Failed to generate risk implications:", err);
      res.status(500).json({ error: "Failed to generate risk implications", message: err.message });
    }
  });

  app.post("/api/explore-theme", async (req, res) => {
    try {
      const { query } = req.body;
      if (!query) return res.status(400).json({ error: "query required" });

      const prompt = `You are a macro risk analyst. Answer the user's question about macro themes, risk concerns, or market implications.

User question: ${query}

Provide a detailed, insightful response (3-5 paragraphs) covering key risks, market implications, and relevant context.`;

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 800
      });

      res.json({ response: result.choices[0]?.message?.content || "No response generated" });
    } catch (err: any) {
      console.error("Failed to explore theme:", err);
      res.status(500).json({ error: "Failed to explore theme", message: err.message });
    }
  });

  app.post("/api/chat", async (req, res) => {
    try {
      const { message, themes } = req.body;
      if (!message) return res.status(400).json({ error: "message required" });

      const themeContext = themes ? themes.slice(0, 5).map((t: any) => `${t.name} (${t.heat}, score: ${t.score})`).join(", ") : "No themes available";

      const prompt = `You are a macro risk analyst assistant. Answer the user's question about macro themes and markets.

Current top themes: ${themeContext}

User question: ${message}

Provide a concise, insightful response (2-3 sentences max).`;

      const result = await openai.chat.completions.create({
        model: "gpt-4o-mini",
        messages: [{ role: "user", content: prompt }],
        max_tokens: 300
      });

      res.json({ response: result.choices[0]?.message?.content || "I couldn't generate a response." });
    } catch (err: any) {
      console.error("Failed to process chat:", err);
      res.status(500).json({ error: "Failed to process chat", message: err.message });
    }
  });

  return httpServer;
}

function extractKeywordsFromText(text: string): string[] {
  const stopWords = new Set(["the", "and", "for", "with", "from", "this", "that", "will", "have", "been", "are", "was", "were"]);
  const words = text.toLowerCase().match(/\b[a-z]{4,}\b/g) || [];
  return words.filter(w => !stopWords.has(w)).slice(0, 8);
}