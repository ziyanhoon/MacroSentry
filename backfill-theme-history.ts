import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

interface ClassifiedArticle {
  id: string;
  title: string;
  source: string;
  publishedAt: string;
  url: string;
  description: string;
  theme: string;
  emerging_label?: string;
  region: string;
}

interface ThemeHistorySnapshot {
  date: string;
  score: number;
  heat: "hot" | "warm" | "cool";
  count3d: number;
  avgDaily14d: number;
}

const SOURCE_QUALITY: Record<string, number> = {
  "Financial Times": 1.0, "Wall Street Journal": 1.0, "Bloomberg": 1.0,
  "Reuters": 0.95, "The Economist": 0.95, "BBC Business": 0.9,
  "NYT Economy": 0.9, "CNBC": 0.85, "MarketWatch": 0.8
};

function computeRawScoreForDate(
  allArticlesForTheme: ClassifiedArticle[],
  totalArticles3d: number,
  totalArticles14d: number,
  referenceDate: Date
): { rawScore: number; count3d: number; avgDaily14d: number; count5d: number } {
  const threeDaysAgo = new Date(referenceDate.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fiveDaysAgo = new Date(referenceDate.getTime() - 5 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(referenceDate.getTime() - 14 * 24 * 60 * 60 * 1000);

  const count3d = allArticlesForTheme.filter(a => new Date(a.publishedAt) >= threeDaysAgo).length;
  const count5d = allArticlesForTheme.filter(a => new Date(a.publishedAt) >= fiveDaysAgo).length;
  const articles14d = allArticlesForTheme.filter(a => new Date(a.publishedAt) >= fourteenDaysAgo);
  const avgDaily14d = articles14d.length / 14;

  const volumeScore = Math.sqrt(articles14d.length);
  const share3d = totalArticles3d > 0 ? count3d / totalArticles3d : 0;
  const share14d = totalArticles14d > 0 ? articles14d.length / totalArticles14d : 0;
  const attentionShift = share14d > 0 ? share3d / share14d : 1;
  const newsVelocity = count3d / 3;
  const volumeDampening = articles14d.length < 20 ? 0.5 : 1.0;
  const momentum = (attentionShift + newsVelocity * 0.1) * volumeDampening;

  const credibilitySum = articles14d.reduce((sum, a) => sum + (SOURCE_QUALITY[a.source] || 0.5), 0);
  const credibility = articles14d.length > 0 ? credibilitySum / articles14d.length : 0.5;

  const rawScore = 0.75 * volumeScore + 0.20 * momentum + 0.05 * credibility;

  return { rawScore, count3d, avgDaily14d, count5d };
}

function groupByThemesForDate(
  articles: ClassifiedArticle[],
  referenceDate: Date,
  previousScores: Record<string, number>
): Array<{ name: string; score: number; heat: "hot" | "warm" | "cool"; count3d: number; avgDaily14d: number }> {
  const fixedGroups: Record<string, ClassifiedArticle[]> = {};
  const emergingGroups: Record<string, ClassifiedArticle[]> = {};

  for (const a of articles) {
    if (!a.theme) continue; // Skip unclassified articles
    if (a.theme === "Emerging") {
      const label = a.emerging_label;
      if (!label) continue;
      if (!emergingGroups[label]) emergingGroups[label] = [];
      emergingGroups[label].push(a);
    } else {
      if (!fixedGroups[a.theme]) fixedGroups[a.theme] = [];
      fixedGroups[a.theme].push(a);
    }
  }

  const threeDaysAgo = new Date(referenceDate.getTime() - 3 * 24 * 60 * 60 * 1000);
  const fourteenDaysAgo = new Date(referenceDate.getTime() - 14 * 24 * 60 * 60 * 1000);

  const allArticles = [...Object.values(fixedGroups).flat(), ...Object.values(emergingGroups).flat()];
  const totalArticles3d = allArticles.filter(a => new Date(a.publishedAt) >= threeDaysAgo).length;
  const totalArticles14d = allArticles.filter(a => new Date(a.publishedAt) >= fourteenDaysAgo).length;

  const themeRawScores: Array<{ name: string; group: ClassifiedArticle[]; rawScore: number; count3d: number; avgDaily14d: number; count5d: number }> = [];

  for (const [name, group] of Object.entries(fixedGroups)) {
    const { rawScore, count3d, avgDaily14d, count5d } = computeRawScoreForDate(group, totalArticles3d, totalArticles14d, referenceDate);
    themeRawScores.push({ name, group, rawScore, count3d, avgDaily14d, count5d });
  }

  for (const [label, group] of Object.entries(emergingGroups)) {
    const { rawScore, count3d, avgDaily14d, count5d } = computeRawScoreForDate(group, totalArticles3d, totalArticles14d, referenceDate);
    themeRawScores.push({ name: label, group, rawScore, count3d, avgDaily14d, count5d });
  }

  const themes: Array<{ name: string; score: number; heat: "hot" | "warm" | "cool"; count3d: number; avgDaily14d: number }> = [];

  for (const themeData of themeRawScores) {
    const articleCount = themeData.group.length;
    const baseScore = articleCount / 5;
    const momentum = themeData.count5d / (themeData.avgDaily14d * 5);
    const momentumBonus = (momentum - 1) * 5;
    let rawScore = Math.min(Math.round(baseScore + momentumBonus), 100);

    let score = previousScores[themeData.name]
      ? Math.round(0.5 * previousScores[themeData.name] + 0.5 * rawScore)
      : rawScore;

    score = Math.max(score, 0);

    let heat: "hot" | "warm" | "cool" = score >= 70 ? "hot" : score >= 40 ? "warm" : "cool";

    if (articleCount >= 150) {
      heat = "hot";
      score = Math.max(score, 75);
    } else if (articleCount >= 80) {
      heat = "warm";
      score = Math.max(score, 40);
    }

    themes.push({ name: themeData.name, score, heat, count3d: themeData.count3d, avgDaily14d: Math.round(themeData.avgDaily14d * 100) / 100 });
  }

  return themes;
}

function generateDateRange(days: number): Date[] {
  const dates: Date[] = [];
  const now = new Date();
  now.setHours(0, 0, 0, 0);

  for (let i = days - 1; i >= 1; i--) {
    const date = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
    dates.push(date);
  }

  return dates;
}

async function backfillThemeHistory() {
  console.log("Starting historical theme scoring backfill...");

  const articlesPath = join(process.cwd(), "data", "articles.json");
  if (!existsSync(articlesPath)) {
    console.error("articles.json not found!");
    return;
  }

  const articles: ClassifiedArticle[] = JSON.parse(readFileSync(articlesPath, "utf-8"));
  console.log(`Loaded ${articles.length} articles`);

  const dates = generateDateRange(14);
  console.log(`Processing ${dates.length} dates from ${dates[0].toISOString().split('T')[0]} to ${dates[dates.length - 1].toISOString().split('T')[0]}`);

  let previousScores: Record<string, number> = {};
  const history: Record<string, ThemeHistorySnapshot[]> = {};

  for (const date of dates) {
    const dateStr = date.toISOString().split('T')[0];
    console.log(`Processing ${dateStr}...`);

    const relevantArticles = articles.filter(a => new Date(a.publishedAt) <= date);
    const themes = groupByThemesForDate(relevantArticles, date, previousScores);

    for (const theme of themes) {
      if (!history[theme.name]) history[theme.name] = [];
      history[theme.name].push({
        date: dateStr,
        score: theme.score,
        heat: theme.heat,
        count3d: theme.count3d,
        avgDaily14d: theme.avgDaily14d
      });
    }

    previousScores = Object.fromEntries(themes.map(t => [t.name, t.score]));
    console.log(`  Processed ${themes.length} themes`);
  }

  const historyPath = join(process.cwd(), "data", "theme_history.json");
  writeFileSync(historyPath, JSON.stringify(history, null, 2));
  console.log(`\nBackfill complete! Written to ${historyPath}`);
  console.log(`Total themes: ${Object.keys(history).length}`);
}

backfillThemeHistory().catch(err => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
