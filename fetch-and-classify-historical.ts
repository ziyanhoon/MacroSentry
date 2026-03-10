import { writeFileSync } from "fs";
import { join } from "path";
import fetch from "node-fetch";
import { config } from "dotenv";

config();

const API_KEY = process.env.NEWS_API_KEY;

const KEYWORDS = [
  "economy", "inflation", "interest rates", "central bank", "AI",
  "semiconductors", "oil", "energy", "geopolitics", "trade war",
  "recession", "GDP", "jobs report", "financial markets", "tariffs"
];

type Region = "US" | "EU" | "China" | "APAC" | "Global" | "Other";

interface NewsArticle {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  description: string;
}

interface ClassifiedArticle extends NewsArticle {
  theme: string;
  emerging_label?: string;
  region: Region;
}

const FIXED_TAXONOMY: Record<string, { keywords: string[] }> = {
  "Inflation & Prices": {
    keywords: ["inflation", "cpi", "consumer price", "price index", "pce", "core inflation", "disinflation", "deflation", "cost of living"],
  },
  "Central Bank Policy": {
    keywords: ["federal reserve", "fed ", "fed's", "fomc", "rate cut", "rate hike", "interest rate", "monetary policy", "powell", "fed funds", "hawkish", "dovish", "quantitative tightening", "qt ", "qe ", "central bank", "ecb", "bank of japan", "boj", "bank of england", "boe", "pboc", "rba", "bank of canada", "riksbank", "snb"],
  },
  "Growth & Recession": {
    keywords: ["gdp", "economic growth", "expansion", "growth rate", "productivity", "output", "economic activity", "business cycle", "industrial production", "manufacturing pmi", "services pmi", "recession", "contraction", "slowdown", "downturn", "hard landing", "soft landing", "yield curve inversion", "inverted yield", "consumer spending", "retail sales", "consumer confidence", "discretionary spending", "consumer sentiment", "shopping", "e-commerce"],
  },
  "Employment & Labor": {
    keywords: ["unemployment", "jobless", "payroll", "nonfarm", "labor market", "job report", "wage growth", "labor force", "participation rate", "job opening", "jolts", "layoff", "hiring"],
  },
  "Geopolitics & Conflicts": {
    keywords: ["geopolit", "war ", "conflict", "military", "nato", "invasion", "diplomatic", "nuclear threat", "missile", "tension", "escalation", "sanction", "embargo", "export control", "trade restriction", "economic warfare", "financial sanction", "asset freeze", "swift ban", "strike", "attack", "projectile", "combat", "hostilities"],
  },
  "Trade & Tariffs": {
    keywords: ["tariff", "trade war", "trade deal", "import dut", "export ban", "export control", "trade deficit", "trade surplus", "protectionism", "trade barrier", "customs"],
  },
  "Energy & Commodities": {
    keywords: ["oil", "crude", "brent", "wti", "opec", "energy price", "natural gas", "lng", "petroleum", "gasoline", "fuel", "commodity", "gold", "silver", "copper", "metal", "agricultural", "wheat", "corn", "soybean", "commodity index", "raw material"],
  },
  "China Economy": {
    keywords: ["china econom", "chinese econom", "yuan", "renminbi", "beijing", "xi jinping", "china gdp", "china trade", "evergrande", "property sector", "property crisis", "china stimulus"],
  },
  "Credit & Banking": {
    keywords: ["credit spread", "high yield", "investment grade", "corporate bond", "credit risk", "default rate", "distressed debt", "junk bond", "credit quality", "bank crisis", "bank fail", "bank run", "deposit", "liquidity crisis", "systemic risk", "financial stability", "bank stress", "fdic", "capital ratio", "housing", "mortgage", "real estate", "home price", "home sales", "housing start", "property market", "mortgage rate", "refinancing", "foreclosure"],
  },
  "Bond Markets & Rates": {
    keywords: ["treasury", "treasuries", "yield", "bond", "10-year", "10y", "2-year", "2y", "30-year", "gilt", "bund", "duration", "convexity"],
  },
  "Currency & Emerging Markets": {
    keywords: ["dollar", "currency", "forex", "fx market", "exchange rate", "dollar strength", "dollar weakness", "currency war", "devaluation", "revaluation", "dxy", "euro dollar", "yen carry", "emerging market", "em debt", "em crisis", "capital flight", "contagion", "developing econom", "frontier market", "em currency", "sovereign default", "debt distress"],
  },
  "Fiscal Policy": {
    keywords: ["fiscal policy", "government spending", "budget deficit", "debt ceiling", "fiscal stimulus", "austerity", "tax policy", "infrastructure spending", "regulat", "compliance", "sec ", "finra", "banking rule", "capital requirement", "dodd-frank", "basel", "mica", "crypto regulat", "financial oversight"],
  },
};

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
  for (const [pattern, label] of emergingPatterns) {
    if (pattern.test(text)) return label;
  }
  return "";
}

function classifyArticle(article: NewsArticle): ClassifiedArticle {
  const text = `${article.title} ${article.description}`.toLowerCase();
  let bestTheme: string | null = null;
  let bestScore = 0;
  for (const [themeName, config] of Object.entries(FIXED_TAXONOMY)) {
    let score = 0;
    for (const kw of config.keywords) {
      if (text.includes(kw)) score += kw.length;
    }
    if (score > bestScore) {
      bestScore = score;
      bestTheme = themeName;
    }
  }
  const region = detectRegion(article.title, article.description);
  if (bestTheme && bestScore >= 3) {
    return { ...article, theme: bestTheme, region };
  }
  const emergingLabel = deriveEmergingLabel(article);
  return { ...article, theme: "Emerging", emerging_label: emergingLabel, region };
}

async function fetchArticlesForDate(date: string): Promise<any[]> {
  const articles: any[] = [];

  for (const keyword of KEYWORDS) {
    try {
      const url = `https://newsapi.org/v2/everything?q=${encodeURIComponent(keyword)}&from=${date}&to=${date}&sortBy=publishedAt&pageSize=100&language=en&apiKey=${API_KEY}`;

      const res = await fetch(url);
      if (!res.ok) {
        console.log(`  ⚠️  ${keyword}: ${res.status}`);
        continue;
      }

      const data: any = await res.json();
      if (data.articles) {
        articles.push(...data.articles);
        console.log(`  ✓ ${keyword}: ${data.articles.length} articles`);
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (err: any) {
      console.log(`  ✗ ${keyword}: ${err.message}`);
    }
  }

  return articles;
}

async function fetchAndClassify() {
  if (!API_KEY) {
    console.error("NEWS_API_KEY not found in environment!");
    return;
  }

  console.log("Fetching and classifying articles from Feb 23 to Mar 3...\n");

  const startDate = new Date("2026-02-23");
  const endDate = new Date("2026-03-03");
  const allArticles: any[] = [];

  for (let d = new Date(startDate); d <= endDate; d.setDate(d.getDate() + 1)) {
    const dateStr = d.toISOString().split("T")[0];
    console.log(`Fetching ${dateStr}...`);

    const articles = await fetchArticlesForDate(dateStr);
    allArticles.push(...articles);
    console.log(`  Total: ${articles.length} articles\n`);
  }

  const seen = new Set<string>();
  const deduped = allArticles.filter((a: any) => {
    if (!a.title || a.title === "[Removed]") return false;
    const key = a.url || a.title;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const classified: ClassifiedArticle[] = deduped.map((a: any, i: number) => classifyArticle({
    id: `newsapi-${i}-${Date.now()}`,
    title: a.title || "",
    source: a.source?.name || "Unknown",
    publishedAt: a.publishedAt || new Date().toISOString(),
    url: a.url || "",
    description: a.description || "",
  }));

  const outputPath = join(process.cwd(), "scripts", "classified_articles.json");
  writeFileSync(outputPath, JSON.stringify(classified, null, 2));

  console.log(`\nComplete!`);
  console.log(`Fetched: ${allArticles.length} articles`);
  console.log(`Deduplicated: ${deduped.length} articles`);
  console.log(`Classified: ${classified.length} articles`);
  console.log(`Output: ${outputPath}`);
}

fetchAndClassify().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
