# MacroSentry

AI-powered macro intelligence and reasoning platform — real-time macro news aggregation, theme heat detection, causal chain analysis, historical analogues, and cross-asset impact mapping in one unified dashboard.

MacroSentry helps users move beyond headline monitoring by turning scattered macro news into structured narratives, transmission pathways, and market-relevant insights.

It is designed not just to tell users **what is hot**, but also:

- **why it matters**
- **how it may propagate through the economy**
- **which asset classes may be affected**
- **what similar historical episodes looked like**

---

## Why MacroSentry?

| Problem | Solution |
|---|---|
| Macro news is fragmented across many sources | Aggregates macro-relevant news into a single structured dashboard |
| It is hard to tell which narratives are truly accelerating | Uses theme heat scoring based on volume, momentum, and source quality |
| Headlines rarely explain economic transmission | Causal chain analysis maps how macro shocks flow into inflation, rates, growth, and markets |
| Investors struggle to connect themes across markets | Cross-theme correlation and cross-asset impact analysis reveal broader macro linkages |
| It is difficult to judge whether current conditions are unprecedented | Historical analogue engine compares live themes with similar past macro episodes |
| News dashboards often stop at summarisation | MacroSentry combines summarisation, explanation, propagation logic, and market interpretation |

---

## Core Product Pillars

### 1. Theme Heat Detection
MacroSentry continuously scans macro news and classifies articles into predefined market themes such as geopolitics, inflation, central banks, energy, trade, credit stress, and growth slowdown.

Each theme is ranked using a heat engine that combines:
- article volume
- momentum acceleration
- persistence
- source credibility

This helps users identify which macro narratives are genuinely gaining traction.

### 2. Causal Chain Analysis
One of MacroSentry’s key differentiators is its causal chain engine.

For each macro theme, the platform explains how an initial shock may propagate through the economy. For example:

`Geopolitical conflict → energy supply disruption → inflation pressure → tighter policy expectations → asset repricing`

This helps users understand not only what happened, but what could happen next.

### 3. Historical Analogues
MacroSentry compares the current macro setup against similar historical episodes, such as prior oil shocks, financial stress events, or sovereign crises.

Each analogue includes:
- similarity scoring
- event timeline
- historical market outcomes

This allows users to assess whether current patterns resemble known past regimes and how markets behaved during those periods.

### 4. Cross-Asset Impact Translation
For every major macro theme, the system estimates likely implications across key asset classes:

- Rates
- Equities
- FX
- Commodities
- Credit

The goal is to help users bridge the gap between macro headlines and actual investment relevance.

### 5. Cross-Theme Linkages
Macro themes rarely move in isolation. MacroSentry calculates cross-theme relationships to help users understand how one narrative can reinforce or spill over into others.

This allows users to see the broader system-level structure of the macro environment rather than viewing events as disconnected headlines.

### 6. AI Macro Briefing Layer
MacroSentry uses LLM-powered summarisation to generate:
- key milestones
- business implications
- daily and weekly macro briefings
- contextual Q&A responses

This gives users a research-assistant-style experience without forcing them to manually read through dozens of articles.

---

## Key Features

### Macro Intelligence Dashboard
- Theme heat map with ranked macro narratives
- Hot themes and active escalation alerts
- Theme activity radar across volume and momentum
- 14-day theme momentum tracking

### Deep-Dive Theme Analysis
- Theme-specific summaries and business implications
- Causal chain analysis
- Cross-theme correlation logic
- Cross-asset impact estimates
- Historical analogue matching

### News Feed Intelligence
- Filterable article stream by:
  - macro theme
  - region
  - source
  - time window
  - sector
- Sector-aware news classification
- Direct access to original supporting articles

### Economic & Market Context
- Live macro indicators including inflation, employment, growth, and rates
- Market context via asset and indicator tracking
- Earnings calendar for major listed firms
- Corporate signal detection linked to broader macro narratives

### Visual Reasoning Tools
- Market Graph for transmission pathway visualisation
- Theme Evolution view for narrative lifecycle tracking
- Summary tab for AI-generated daily and weekly macro synthesis
- Workspace for deeper research and note-taking

---

## How It Works

### 1. Data Ingestion
The platform aggregates macro-relevant content from multiple external sources including RSS feeds, NewsAPI, GDELT fallback, macroeconomic data providers, and market endpoints.

### 2. Theme Classification
Incoming articles are filtered, cleaned, and tagged by:
- macro theme
- region
- sector relevance
- timeline

### 3. Heat Scoring
Themes are scored using a weighted blend of:
- recent article count
- momentum acceleration
- persistence over time
- source quality
- supporting signals

This produces a ranked hot/warm/cool view of the macro landscape.

### 4. Reasoning & Enrichment
Once themes are grouped, the platform enriches them with:
- AI-generated milestones
- business implications
- causal chains
- cross-theme relationships
- cross-asset interpretations
- historical analogues

### 5. Dashboard Delivery
All structured outputs are served through the application backend and rendered into interactive dashboard modules for research, monitoring, and macro decision support.

---

## Dashboard Modules

- **Overview** — macro command center with hot themes, alerts, radar, and indicators
- **Themes** — deep-dive three-panel macro analysis
- **News Feed** — supporting articles behind each macro signal
- **Economic Indicators** — live quantitative macro dashboard
- **Alerts** — active and escalation alerts with AI exploration
- **Summary** — AI-generated daily and weekly macro briefings
- **Market Graph** — visualisation of macro transmission pathways
- **Theme Evolution** — historical development of macro narratives
- **Earnings Calendar** — upcoming corporate catalysts by company and sector
- **Corporate Signals** — company-level signals linked back to broader macro themes

---

## Architecture Overview

MacroSentry is built as a full-stack TypeScript application with a layered intelligence pipeline:

`News & Market Data Sources → Classification Engine → Theme Heat Scoring → Causal / Analogue / Asset Impact Layer → API Layer → Interactive Dashboard`

Core stack:
- **Frontend:** React + TypeScript + Vite
- **Backend:** Node.js + Express + TypeScript
- **AI:** Groq + OpenAI
- **Data Sources:** RSS, NewsAPI, GDELT, FRED, Yahoo Finance, Financial Modeling Prep
- **Persistence:** JSON-based local storage for articles, history, and state

---

## Project Positioning

MacroSentry is not just a macro news reader.

It is a macro reasoning platform built to help users answer:

- What macro themes are getting hotter?
- Is this real momentum or just headline noise?
- How might this shock propagate through the economy?
- Which asset classes are most exposed?
- Have we seen something similar before?
- What were the historical market outcomes?

---

## Roadmap

- Stronger historical backfill for theme evolution
- Improved analogue retrieval and similarity scoring
- Better cross-asset calibration using live market reactions
- Expanded alerting and notification workflows
- More advanced sector and company linkage logic
- Stronger persistence layer beyond local file storage
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
