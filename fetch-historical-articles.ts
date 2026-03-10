import { readFileSync, writeFileSync, existsSync } from "fs";
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

async function fetchHistoricalArticles() {
  if (!API_KEY) {
    console.error("NEWS_API_KEY not found in environment!");
    return;
  }

  console.log("Fetching historical articles from Feb 23 to Mar 3...\n");

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

  const articlesPath = join(process.cwd(), "data", "articles.json");
  let existing: any[] = [];

  if (existsSync(articlesPath)) {
    existing = JSON.parse(readFileSync(articlesPath, "utf-8"));
  }

  const existingUrls = new Set(existing.map((a: any) => a.url));
  const newArticles = allArticles.filter(a => !existingUrls.has(a.url));

  const combined = [...existing, ...newArticles];
  writeFileSync(articlesPath, JSON.stringify(combined, null, 2));

  console.log(`\nComplete!`);
  console.log(`Fetched: ${allArticles.length} articles`);
  console.log(`New: ${newArticles.length} articles`);
  console.log(`Total in file: ${combined.length} articles`);
}

fetchHistoricalArticles().catch(err => {
  console.error("Failed:", err);
  process.exit(1);
});
