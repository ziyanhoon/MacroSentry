# MacroSentry
AI-powered macro intelligence dashboard — real-time macro news aggregation, theme heat detection, market context, and AI-generated business implications in one unified interface.

![TypeScript](https://img.shields.io/badge/TypeScript-Project-blue)
![React](https://img.shields.io/badge/React-Frontend-61dafb)
![Express](https://img.shields.io/badge/Express-Backend-black)
![License](https://img.shields.io/badge/License-MIT-green)

**MacroSentry** helps users move from scattered macro headlines to a more structured understanding of what is actually heating up across markets, policy, and global economic themes.

It combines:
- multi-source macro news aggregation
- rule-based theme classification
- heat and momentum scoring
- AI-generated milestones and implications
- market indicator overlays
- workspace tools for deeper research

---

## Why MacroSentry?

| Problem | Solution |
|---|---|
| Macro news is scattered across many sources | Aggregates macro-relevant articles into one dashboard |
| Hard to tell what is noise vs what is truly heating up | Uses theme-based heat scoring built from volume, momentum, and persistence |
| Headlines often lack market context | Connects themes with economic indicators, asset impacts, and market charts |
| News is descriptive but not actionable | Uses AI to generate milestones, implications, and macro explainers |
| Research is fragmented across tabs and notes | Includes a workspace for note-taking, analogue search, and risk exploration |

---

## Key Features

### Macro Theme Intelligence
- Detects and groups articles into macro themes such as inflation, rates, commodities, geopolitics, China, credit stress, and growth slowdown
- Tracks **theme heat**, **momentum**, and **trend direction**
- Surfaces the most important themes through a ranked dashboard view
- Supports emerging theme detection for developing narratives

### AI Insight Layer
- Generates **key milestones** for each macro theme
- Produces **business implications** from recent developments
- Provides AI-generated **macro summary** and **daily briefing**
- Supports theme exploration through prompt-based analysis and Q&A

### News & Signal Aggregation
- Pulls data from multiple sources including:
  - RSS feeds
  - NewsAPI
  - GDELT fallback
- Filters noise and organizes content into structured theme clusters
- Tracks **corporate signals** by linking company mentions to sector relevance

### Market & Macro Context
- Integrates **economic indicators** for macro context
- Fetches **market time series** for selected assets and indicators
- Includes **earnings calendar** support for large listed companies
- Maps themes to likely asset class impacts across:
  - Equities
  - Rates
  - FX
  - Commodities
  - Credit

### Research Workspace
- Dedicated workspace for saving macro notes
- Historical analogue search to compare today’s setup with past events
- Risk signal exploration for deeper analysis
- Designed to support structured research, not just passive monitoring

---

## Dashboard Modules

MacroSentry is organized into multiple dashboard views:

- **Overview** — top themes, dashboard summary, and macro snapshot
- **Themes** — deeper theme-by-theme analysis with heat, articles, and AI insights
- **News Feed** — filtered article stream by region, source, and macro theme
- **Indicators** — macroeconomic data and indicator tracking
- **Risk Alerts** — important themes with elevated heat and risk relevance
- **Summary** — AI-generated synthesis of the macro landscape
- **Market Graph** — market context and visual trend mapping
- **Theme Evolution** — historical view of how themes change over time
- **Workspace** — note-taking, analogue search, and risk exploration
- **Earnings Calendar** — upcoming earnings for major listed companies
- **Corporate Insights** — company-linked signal detection from news flow

---

## How It Works

### 1. Data Ingestion
MacroSentry continuously gathers data from external sources including RSS feeds, NewsAPI, GDELT fallback, economic data providers, and market data endpoints.

### 2. Classification & Grouping
Incoming articles are cleaned, filtered, region-tagged, and classified into macro themes using a rule-based keyword engine.

### 3. Heat Scoring Engine
Each theme is scored based on:
- recent article volume
- short-term momentum
- prior activity baseline
- persistence over time
- corporate signal boost

This produces a **hot / warm / cool** state for each theme.

### 4. AI Enrichment
Structured theme clusters are then enriched with LLM-generated:
- milestones
- business implications
- explainers
- summaries
- analogue comparisons

### 5. Dashboard Delivery
The backend exposes structured REST endpoints that the frontend consumes to render interactive charts, filters, cards, and research tools.

---

## Architecture Overview

MacroSentry is built as a **full-stack TypeScript monolith**:

- **Frontend:** React + TypeScript + Vite
- **Backend:** Node.js + Express + TypeScript
- **Styling/UI:** Tailwind CSS + Radix UI
- **Charts:** Recharts
- **Data Fetching:** TanStack React Query
- **AI:** Groq + OpenAI
- **Persistence:** local JSON-based storage for articles, theme history, and state
- **External Data:** RSS feeds, NewsAPI, GDELT, FRED, Yahoo Finance, Financial Modeling Prep

### Architecture Flow
`External News & Market Sources → Ingestion Engine → Theme Classification → Heat Scoring → AI Enrichment → REST API Layer → Interactive Dashboard`

---

## Tech Stack

| Category | Technologies |
|---|---|
| Frontend | React, TypeScript, Vite, Wouter, Tailwind CSS, Radix UI, Recharts |
| Backend | Node.js, Express, TypeScript |
| Data Sources | RSS, NewsAPI, GDELT, FRED, Yahoo Finance, Financial Modeling Prep |
| AI | Groq, OpenAI |
| Data Layer | JSON-based local persistence |
| Tooling | tsx, esbuild, Drizzle ORM, PostgreSQL scaffolding |

---

## Example Use Cases

- Monitor which macro themes are genuinely heating up
- Understand how inflation, rates, geopolitics, or energy developments are evolving
- Turn raw headlines into business-relevant implications
- Explore cross-theme risks and possible market reactions
- Save research notes and compare current developments with historical analogues

---

## Quick Start

```bash
git clone <your-repo-url>
cd <your-project-folder>
npm install
npm run dev
