# ceos-jobs

**Jobs — a personal AI recruitment agent that finds, tailors for, applies to, and tracks SWE/quant/data internships and new-grad roles, reporting into the CEO's Enterprise fleet dashboard.**

This is the owner repo for "Jobs," one agent in the personal AI fleet managed from `ceos-enterprise`. It automates the high-toil, low-judgment parts of recruiting — ingesting listings, tailoring resumes, assisted application submission, and end-to-end pipeline tracking — while keeping a human in the loop for every irreversible step. The design is deliberately ToS-conservative: it leans on community GitHub feeds and public ATS APIs, and never automates LinkedIn or Handshake.

## What it does

- **Scrape listings** — Pull from three tiers, in order of signal and safety: (1) community GitHub JSON feeds (`SimplifyJobs/Summer2026-Internships`, `vanshb03/New-Grad-2026`), fetched daily from `raw.githubusercontent.com` with no auth; (2) public no-auth ATS endpoints — Greenhouse (`boards-api.greenhouse.io`), Lever (`api.lever.co/v0`, with the `commitment=internship` filter), and Ashby (`api.ashbyhq.com`, which returns compensation data); (3) breadth aggregators JSearch (free tier, 500 req/month) and Adzuna for coverage of roles the feeds and ATS endpoints miss. LinkedIn, Indeed, and Handshake are off-limits — no usable/permitted API, and account-ban risk for a Berkeley student is asymmetric. Workday is reachable only via a managed scraper (Apify), used sparingly for specific high-value targets.
- **Tailor resumes & cover letters** — A YAML/JSON master profile is the single source of truth. An LLM layer parses each JD, surfaces matching bullets, and rewrites them *strictly grounded to the source* (no invented metrics or tools), gated by a content-preservation check (cosine similarity ≥ 0.72) and a mandatory human diff review before any file is used. Rendering is deterministic via RenderCV/Typst, single-column, ATS-safe. Cover letters are generated per-listing from scraped company context, then read before sending.
- **Assisted-submit** — Tiered. Tier 1 (full-auto, low-risk): direct POST to Greenhouse/Lever Job Board APIs when no CAPTCHA is present, with randomized delays and a daily cap. Tier 2 (one-click confirm): browser autofill via Simplify Copilot or a local Playwright script for Workday/Taleo/iCIMS/Ashby, always pausing at the review page for a human to confirm and click Submit. LinkedIn Easy Apply is never automated. A qualification gate (LLM JD-match score) runs before any role is queued.
- **Track the pipeline** — A nine-stage status machine over a Postgres schema, with deduplication on a normalized `company|title|location` key, automatic Gmail status ingestion (`gmail.readonly` + LLM classification), Google Calendar events for OAs/interviews, follow-up drafting (never auto-sent), and a metrics dashboard surfacing per-source yield, application-to-interview rate, and resume-version A/B results.

## Stack

- **TypeScript / Next.js 15** (Vercel-hosted) — dashboard UI, API routes, and the durable agent loop on **Vercel Workflows** (GA; sidesteps the 800s function ceiling). The `/applications` page lives in `ceos-enterprise`.
- **Python worker** — all scraping and long Playwright browser sessions, run on **GitHub Actions** scheduled workflows (free) or a small always-on Render/Railway box. Functions on Vercel are stateless and unsuitable for multi-minute browser automation.
- **Postgres (Vercel/Neon)** — durable job queue (`SELECT ... FOR UPDATE SKIP LOCKED`), application state, and tracking, all in one store. **Upstash Redis** (the successor to the deprecated Vercel KV) holds ephemeral dedup hashes and rate-limit counters only.
- **Claude API** — `claude-haiku-4-5` ($1/$5 per MTok) for relevance classification and dedup, `claude-sonnet-4-6` ($3/$15) for JD parsing and resume tailoring, `claude-opus-4-8` ($5/$25, 1M context) for final cover-letter polish and long-form essay answers. Batch API (50% off) for overnight tailoring passes.
- **Playwright + Firecrawl** — browser autofill for ATS portals without a public apply API; Firecrawl (or `httpx` + BeautifulSoup / `selectolax`) for per-listing company research and static-page parsing.

## How it fits the fleet

`ceos-jobs` is the owned repo for the **`jobs`** agent in the CEO's Enterprise fleet. It runs independently — its own scraping worker, queue, and Workflows loop — but reports state into `ceos-enterprise`: the fleet dashboard reads pipeline status, submission timestamps, and response tracking from this repo's Postgres via the integration layer in `integration/ceos-enterprise/`. A status reporter (`scripts/report-status.ts`) pushes a heartbeat and summary metrics to the parent dashboard so Jobs shows up alongside the other fleet agents.

## Repo layout

```
ceos-jobs/
├── README.md                      # you are here
├── docs/
│   ├── RESEARCH.md                # source research digest (ingestion, submission, tracking, tailoring, architecture)
│   ├── PROJECT_PLAN.md            # phased build sequence (start here to build)
│   ├── ARCHITECTURE.md            # queue design, Workflows loop, model assignment, secrets handling
│   └── INTEGRATION.md             # how Jobs reports into the ceos-enterprise fleet dashboard
├── db/
│   └── schema.sql                 # jobs / applications / events / emails tables + dedup_key
├── scripts/
│   └── report-status.ts           # pushes heartbeat + metrics to ceos-enterprise
└── integration/
    └── ceos-enterprise/           # contract + adapters for the fleet dashboard
```

## Status

This repo currently contains the **plan, research, and integration design** — not a running system. `docs/` holds the grounded research digest and the build plan, `db/schema.sql` defines the data model, and `integration/ceos-enterprise/` specifies the fleet contract. The scraping worker, Workflows orchestration, tailoring pipeline, and dashboard page are designed but **not yet implemented**.

## Getting started / next steps

Start with **`docs/PROJECT_PLAN.md`** — it lays out the phased build sequence (Phase 1: Postgres schema + SKIP LOCKED queue + JobSpy/GitHub-feed ingest with Haiku classification → Phase 2: Sonnet tailoring on Vercel Workflows → Phase 3: Telegram approval + Greenhouse/Lever submission → Phase 4: the `/applications` dashboard page in `ceos-enterprise`). Read `docs/ARCHITECTURE.md` alongside it for queue, model-assignment, and secrets decisions, and `docs/INTEGRATION.md` for the fleet reporting contract.
