# Jobs — Project Plan

The phased build plan for **Jobs**, the personal AI recruitment agent that lives in the `ceos-jobs`
repo and reports into the CEO's Enterprise fleet dashboard (`ceos-enterprise`).

Audience: me (the owner) and my future self picking this up cold. This document is the contract for
what gets built, in what order, and how I know each phase is done. Everything here is grounded in the
research digest — reuse its concrete tool names, endpoints, and risk callouts rather than reinventing.

---

## 1. Goal & success metrics

**Goal.** Turn the recruitment grind into a supervised pipeline: Jobs finds relevant SWE / quant / data
internship and new-grad listings, scores them against my profile, drafts a truthfully-tailored resume
and cover letter per role, fills the application form, and tracks the outcome — while I stay in the loop
for every submission and every outbound email to a human.

**The single strongest principle from the research:** quality over volume. A documented full-blast bot
produced 20 interviews from 5,000 applications (0.5%). I am explicitly *not* building that. The whole
point of human-in-the-loop is to keep application quality high enough to beat that number by an order of
magnitude at a fraction of the volume.

**Success metrics (the dashboard must surface these):**

| Metric | Target | Why |
| --- | --- | --- |
| Quality applications / week | 15–25, each with **< 5 min** of my time | Human reviews tailoring + clicks submit; everything else is automated |
| Application-to-interview rate | **> 3%** (CareerPlug 2025 median is 3%; < 2% means resume/targeting is broken) | The headline funnel health metric |
| Response rate (any inbound) | tracked, no hard target | Leading indicator before interviews land |
| Per-source yield (interview rate by channel) | tracked; expect referral + `company_careers_page` to beat aggregator feeds 2–5x | Tells me where to spend effort |
| Time-to-first-response | median days, tracked | Detects ghosting and slow cycles |
| Resume version conversion | interview rate by `resume_version` after ~30 apps | The highest-signal A/B test I have |

If after a few weeks per-source yield shows the GitHub feeds underperforming direct ATS polling and
referrals, that finding alone justifies the build.

---

## 2. Scope

### In scope
- **Ingestion** from low-/no-ToS-risk sources: community GitHub JSON feeds (SimplifyJobs/Summer2026-Internships,
  vanshb03/New-Grad-2026), public no-auth ATS endpoints (Greenhouse, Lever, Ashby, Workable, Recruitee),
  and breadth aggregators (JSearch free tier, Adzuna).
- **Dedup, scoring, and matching** against a structured master profile.
- **Truthful resume + cover-letter tailoring** with a mandatory human diff-review gate.
- **Assisted submission**: a stored canonical profile that powers autofill; direct API submit for
  Greenhouse/Lever where CAPTCHA is absent; Playwright/Simplify-style autofill for Workday/Taleo/iCIMS/Ashby.
  Every path ends with a **human confirm click**.
- **Tracking**: Gmail status ingestion (read-only), follow-up *drafting* (never auto-send), Google
  Calendar events for OAs/interviews, and analytics surfaced on the `/applications` page in `ceos-enterprise`.

### Out of scope — explicitly OUT for the MVP, and OUT permanently where noted
- **Anything that violates LinkedIn ToS — permanently OUT.** No LinkedIn job scraping, no profile
  scraping, no Easy Apply automation. LinkedIn has no usable developer API for individuals, enforces
  with permanent bans (< 15% recovery), settled hiQ for $500k + injunction, and added "human-impossible
  velocity" detection in 2025. My LinkedIn is my professional identity — I use it manually, full stop.
- **Auto-submit without human confirm — OUT for MVP.** No application is sent without my explicit
  approval. This is the line that keeps the whole system ToS-safe and quality-high. Re-evaluating it is
  a post-MVP question, not an MVP feature.
- **Handshake automation — permanently OUT.** ToS bans bots/crawlers; a ban kills my Berkeley-exclusive
  postings and OCR access. I check it manually 2–3x/week.
- **Indeed scraping — OUT.** Deprecated public API, robust Cloudflare bot detection; its corpus is
  already covered by JSearch (via Google for Jobs). Not worth the risk.
- **A DIY Workday scraper — OUT.** Akamai blocks single IPs in minutes, tenant data centers vary
  (wd1/wd3/wd5/wd12), schema shifts without notice. If I ever need Workday *ingestion*, I use a managed
  Apify actor for specific high-value targets only. Workday *submission* stays in the assisted-autofill
  tier with a human confirm.
- **Full-blast auto-apply services (LazyApply, LoopCV) — OUT.** Documented 0.5% ROI and ban risk.

---

## 3. Non-negotiable principles

1. **Truthful tailoring.** The LLM may only rephrase and reorder facts that exist in the master profile.
   It must never invent metrics, tools, titles, project names, scale, or outcomes. Enforced at three
   layers: a strict system prompt, Pydantic-schema-grounded output, and a content-preservation score
   (cosine similarity via `sentence-transformers all-MiniLM-L6-v2`; flag any bullet below ~0.72 for
   review). A fabricated "40% latency reduction" surfaces in a technical interview and can get an offer
   rescinded. This rule is load-bearing.
2. **Human-in-the-loop submit.** No application is submitted and no email is sent to a recruiter without
   an explicit human action. The LLM drafts; I approve. One hallucinated company name in a follow-up can
   blacklist me. The Tailoring → Ready transition and the Submit step are both human gates.
3. **Low-ToS-risk ingestion only.** Prioritize the three tiers in order: (1) community GitHub JSON feeds,
   (2) public no-auth ATS endpoints (explicitly designed for third-party consumption), (3) commercial
   aggregator APIs. This covers ~80% of relevant tech internship postings without touching a single
   auth-walled page. No LinkedIn/Handshake/Indeed scraping, ever.
4. **Single source of truth for my data.** One canonical master profile (YAML/JSON) feeds every layer —
   tailoring, autofill, the Greenhouse API submit script. No data is duplicated across tools.
5. **Secrets never touch git.** `ANTHROPIC_API_KEY`, `DATABASE_URL`, Gmail/Calendar OAuth tokens, JSearch
   and Adzuna keys live in Vercel sensitive env vars / GitHub repo secrets / OS keychain. A committed key
   means quota theft. Keep a `.env.example` with names but no values.
6. **Resume content is PII.** It leaves my infra only to the Anthropic API (which does not train on API
   data by default). Store full resume/JD text in Postgres with restricted access, not in KV/Redis.

---

## 4. Architecture at a glance

- **Owner repo:** `ceos-jobs` (this repo). Houses the Python pipeline, the master profile, the tailoring
  templates, and the worker.
- **Dashboard:** `ceos-enterprise` (the fleet). Jobs reports status via the existing `reporter/ceo_report.py`
  helper (`report("jobs", ok=..., summary=...)` → POST to `/api/report` with `x-report-secret`). The
  `/applications` page lives in the dashboard repo and reads from the same Postgres.
- **Stack** (mirrors the fleet): Vercel Postgres (Neon) as the durable store and job queue
  (`SELECT ... FOR UPDATE SKIP LOCKED`), Upstash Redis (successor to the now-deprecated Vercel KV) for
  ephemeral dedup/rate-limit cursors only, Vercel Cron + Vercel Workflows for orchestration, and a
  GitHub Actions scheduled workflow (free, Python, proxy-friendly) for all ingestion. A $7/mo Render/Railway
  box is the deferred upgrade path for persistent Playwright sessions (Phase 4+ only).
- **Models** (Anthropic API): `claude-haiku-4-5` for relevance classification + dedup normalization,
  `claude-sonnet-4-6` for JD parsing + bullet tailoring + first-draft cover letter, `claude-opus-4-8`
  (1M context) for final cover-letter polish and any long-form essay. Batch API (50% off) for overnight
  non-urgent passes. Estimated ~$80–120/mo at 50 relevant JDs/day; set a hard spend cap in the console.

---

## 5. Phased roadmap

Each phase ships something usable on its own. Effort estimates assume part-time student hours (evenings +
weekends); they are honest, not optimistic.

### Phase 0 — Scaffold, schema, status reporter, fleet registration
*Effort: ~1 week.*

Stand up the repo and make Jobs visible in the fleet before writing any real logic.

**Deliverables**
- `ceos-jobs` repo scaffolded: Python pipeline package, `.env.example`, `pyproject.toml`/`requirements.txt`,
  README pointing here.
- Copy `reporter/ceo_report.py` from `ceos-enterprise` into the repo; wire `CEOS_REPORT_URL` and
  `CEOS_REPORT_SECRET` as GitHub repo secrets. A smoke run calls `report("jobs", ok=True, summary="scaffold up")`.
- **Register `jobs` in the fleet:** add an entry to `AGENTS` in `ceos-enterprise/lib/agents.ts`
  (`id: 'jobs'`, name, role, `ownerRepo: 'ceos-jobs'`, skills, schedule). This makes it render on the
  dashboard via the existing `agent_status` table and `getFleet()`.
- Core Postgres schema created (idempotent `CREATE TABLE IF NOT EXISTS`, matching the fleet's pattern).

**Tables touched / created**
- `ceos-enterprise.agent_status` — Jobs writes its row here through the reporter (existing table).
- New in shared Postgres: `companies`, `roles`, `job_listings`, `applications`, `events`, `emails`
  (created here as empty stubs; populated in later phases). `applications` carries the generated
  `dedup_key` column and a `UNIQUE` constraint; `resume_version` and `source_channel` are first-class
  columns from day one (retrofitting them later is unreliable).

**Done when:** the `jobs` card shows up on the `ceos-enterprise` dashboard with a green status from a real
`report()` call, and all six core tables exist in Postgres.

---

### Phase 1 — Ingestion (public feeds + ATS boards) → `job_listings` + dedup
*Effort: ~1.5–2 weeks.*

Get a steady, deduplicated stream of relevant listings with zero scraping risk.

**Deliverables**
- **Primary daily ingest** via GitHub Actions (cron `0 6,18 * * *` or ~8am PT, after Simplify's nightly
  run): raw HTTP GET of
  `https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json`
  and `https://raw.githubusercontent.com/vanshb03/New-Grad-2026/dev/.github/scripts/listings.json`.
  Parse the shared schema (company_name, title, url, locations[], terms, date_posted, active, source, id).
  This alone yields 500–1,500 active listings.
- **Direct ATS polling** for a hard-coded top-100 target-company → ATS map (built once via an ATS detector,
  then frozen to avoid re-detection overhead):
  - Greenhouse: `GET https://boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`
  - Lever: `GET https://api.lever.co/v0/postings/{slug}?mode=json&commitment=internship`
  - Ashby: `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`
  - (Stretch) Workable / Recruitee for Series A–C startups.
  - Rate discipline: max one request per company per hour, ≤ 5 concurrent, respect robots.txt. These are
    LOW risk — designed for public consumption.
- **Breadth pass** (2–3 queries/day): JSearch free tier (500 req/mo) and/or Adzuna free API for roles the
  feeds and ATS endpoints miss. Keys in env vars only.
- **Dedup layer:** generated `dedup_key = lower(trim(company)) || '|' || lower(trim(title)) || '|' ||
  lower(trim(location))` as a `UNIQUE` constraint (zero-cost 90% case). Normalize apply URLs (strip
  tracking params with `urllib.parse`) before storing. Near-duplicates ("SWE Intern" vs "Software
  Engineer Intern 2026") go to a `flagged_duplicates` table for review via `datasketch` MinHash LSH
  (threshold ~0.85 on title+company shingles); only fall back to embeddings after exact-key miss.
- Listings that disappear from a feed are marked `active = false`, **not deleted** (needed for later
  application-timing analysis).
- Status report after each run: `report("jobs", ok=True, summary="312 new · 1,140 active · 18 flagged dup")`.

**Tables touched:** `job_listings` (insert/upsert, mark inactive), `companies`, `roles`,
`flagged_duplicates` (new). Upstash Redis holds the seen-ID dedup set (TTL 30 days) and rate-limit counters.

**Done when:** a single GitHub Actions run pulls both GitHub feeds + the top-100 ATS map + one breadth
query, writes deduplicated rows to `job_listings`, marks vanished listings inactive, and reports a
non-zero count to the fleet — with no manual intervention.

---

### Phase 2 — Matching / scoring + master profile
*Effort: ~1.5 weeks.*

Decide which listings are worth tailoring for, so I never waste a tailoring pass (or API spend) on a bad fit.

**Deliverables**
- **Master profile** as a single YAML file (RenderCV schema): per-role entries with 5–7 skill-tagged
  bullets (`tags: [Python, ML, data-pipeline]`), project entries with a freeform `context` field
  (problem/scale/outcome as raw facts), full work-auth status, GPA, major, grad date, skills list.
  Committed to a private repo, treated as canonical, never modified by the LLM.
- **JD parser** (`claude-sonnet-4-6`, Pydantic output): extract required_skills[], preferred_skills[],
  seniority_level, domain_keywords[], company_context.
- **Relevance classifier** (`claude-haiku-4-5`, ~$0.001/JD): output `{relevant: bool, score: 0–10, reason}`.
  A qualification gate — only roles with match score **> 0.65** advance to the Queued stage. This is the
  spam-flag guardrail: never auto-process roles I'm clearly unqualified for.
- **Skills-gap / tag-match** between JD required_skills and master-profile tags; surfaces matched bullets
  and flags missing skills for the tailoring step.
- Store raw `jd_text` at ingestion time (not just the URL) — postings get taken down and I need the text
  for tailoring and interview prep.

**Tables touched:** `roles` (add `jd_text`, parsed fields), `applications` (created in `Discovered`/`Queued`
stage with `classification_score`).

**Done when:** every new relevant listing gets a JD parse + a relevance score, low-score roles are filtered
out, and qualifying roles land in the `Queued` stage with a stored skills-gap summary.

---

### Phase 3 — Resume / cover-letter tailoring with review gate
*Effort: ~2 weeks.*

Produce a truthfully-tailored, ATS-parseable PDF + cover-letter draft per role — gated on my approval.

**Deliverables**
- **Tailoring pipeline** (per the ResumeFlow-style architecture): tag-match bullets → grounded LLM rewrite
  (`claude-sonnet-4-6`, system prompt: *"Only use facts present in the source bullet. Do not add numbers,
  tools, or experiences not mentioned. If you can't improve it without inventing facts, return it
  unchanged."*) → section selection by JD overlap → **content-preservation gate** (cosine sim < 0.72 →
  mandatory review) → render.
- **Rendering:** RenderCV (YAML → Typst → PDF), single-column only, standard headings, inline contact info,
  bullet-list skills (no tables — Workday/Taleo scramble them), both acronym + full form, consistent
  MM/YYYY dates. Smoke-test every generated PDF through the free `sunnypatell/ats-screener` (Workday/Taleo
  simulation) before it's usable. Don't pay for Jobscan recurringly.
- **Cover letters:** scrape company About + one recent blog post (`httpx` + BeautifulSoup) for grounding,
  then `claude-sonnet-4-6` first draft → optional `claude-opus-4-8` polish. Three paragraphs: company-specific
  hook, one STAR story from the profile, brief close. No fabricated specifics. (Read aloud before use.)
- **Human diff gate:** the pipeline outputs a package — tailored PDF, cover-letter draft, and a side-by-side
  diff of every changed bullet vs. master. Nothing advances to `Ready` without my explicit approval.
  Save the full pre/post LLM output keyed by `JD hash + profile-version hash` (outputs are non-deterministic;
  never regenerate a reviewed submission — reuse the saved one).
- **Versioned outputs:** `{company}_{role}_{YYYY-MM-DD}_resume.pdf`, tracking which profile version + JD
  produced each variant.

**Tables touched:** `applications` (add `resume_version`, `cover_letter`, tailoring score, status
`Tailoring`/`Ready`); a `generated_artifacts` store keyed by the hash pair.

**Done when:** for a queued role I get a tailored single-column PDF that passes ats-screener, a grounded
cover-letter draft, and a diff report — and the role only reaches `Ready` after I approve the diff.

---

### Phase 4 — Assisted submission (autofill, ATS-aware) + manual confirm
*Effort: ~2–2.5 weeks.*

Fill the application form from the master profile, ATS-aware, and stop at a human confirm click.

**Deliverables**
- **Canonical application profile (JSON)** powering every autofill path: name, Berkeley + personal email,
  phone, LinkedIn/GitHub URLs, GPA, major, grad date, full work history, projects, skills, work-auth +
  sponsorship status, EEO answers (decided once), and a library of canned long-form answers ("Why this
  company?", "Technical challenge", "Teamwork"). One source of truth for all submission paths.
- **Tiered submission:**
  - **Tier 1 — Full-auto (where safe):** for Greenhouse/Lever where CAPTCHA is absent, a Python script
    GETs the question schema, maps the profile, and POSTs the application
    (`POST boards-api.greenhouse.io/v1/boards/{token}/jobs/{id}`; Lever `POST /v0/postings/{site}/{id}?key=...`,
    respecting the 2 req/sec limit). API keys stay server-side. **First check the apply page for a
    reCAPTCHA widget**; if present, fall back to Tier 2. Cap ~10–15/day, randomized 2–3s delays.
  - **Tier 2 — Assisted autofill + one-click confirm:** for Workday/Taleo/iCIMS/Ashby/SmartRecruiters,
    fill fields via a Simplify-Copilot-style flow or a local Playwright + stealth script that fills and
    navigates to the review page, then **pauses and notifies me to confirm**. For Workday, a dedicated
    email alias + password manager vault handles the one-account-per-tenant wall; email verification stays
    a human gate. Cap ~5–10/day, 30–120s jitter.
- **Pre-submission quality gate** before any API call or confirm: resume attached, no blank required
  fields, no obviously wrong field mappings, role still active (re-fetch the listing).
- **Approval UX:** a per-application notification (Telegram inline buttons Approve / Skip / Rewrite, or the
  dashboard) showing the tailored diff + cover-letter preview. `pending_approval` rows get a 48h TTL +
  reminder. Submission result (confirmation ID, timestamp) written back.
- **Note on the Greenhouse ToS nuance:** the *Job Board API* POST path is public and designed for
  integrations; *browser automation against the hosted Greenhouse form* is ToS-violating. Use the API path
  for Tier 1; use human-assisted autofill (not a headless bot) for the hosted-form fallback.

**Tables touched:** `applications` (status → `Submitted`, `submitted_at`, confirmation ID, `source_channel`
required at submit time — canonical values: `company_careers_page`, `referral`, `recruiter_outbound`,
`niche_board`, plus aggregator/feed sources). Upstash Redis holds the `pending_approval` set with TTL.

**Done when:** I can take a `Ready` application through to `Submitted` with a single confirm action —
Tier-1 roles via direct API, Tier-2 roles via autofill-then-confirm — with the quality gate enforced and
the result recorded. No submission ever happens without my click.

---

### Phase 5 — Tracking (email status ingestion, reminders, analytics) + live dashboard stats
*Effort: ~2 weeks.*

Close the loop: ingest outcomes, schedule follow-ups, and surface the funnel on the fleet dashboard.

**Deliverables**
- **Gmail status ingestion (read-only, `gmail.readonly`):** incremental scan via the History API
  (`users.history.list` keyed on last `historyId` — O(new messages), not O(inbox)). A cheap keyword prior
  (confirmation / rejection / OA / interview signal phrases from the digest) routes ambiguous emails to
  `claude-sonnet-4-5` tool-use classification (status ENUM, batches of ~50). Run 3x/day via APScheduler.
  Each extraction is independent so one bad email can't contaminate the batch.
- **Nine-stage status machine** enforced forward-only via `STATUS_RANK`; terminal states
  (Rejected/Declined) write-protected: Discovered → Queued → Tailoring → Ready → Submitted → OA/Assessment
  → Interviewing → Offer → Closed.
- **Google Calendar integration (personal account, never berkeley.edu):** on transition to `OA/Assessment`
  or `Interviewing`, LLM-extract the datetime and `events.insert` with colorId (blue=OA, green=interview,
  red=deadline) + 24h/1h reminders; store `gcal_event_id`.
- **Follow-ups & reminders:** 21-day ghosting threshold (internship cycles move slow) → LLM-drafted
  follow-up surfaced as a dismissible banner, **only if still in `Submitted`**, **never auto-sent** —
  stored in a `pending_emails` table with a Send button. OA deadline reminders 3 days out; interview prep
  brief (LLM question list + company research from stored `jd_text`) 48h before.
- **Analytics dashboard** — the `/applications` page in `ceos-enterprise`: SWR (~10s revalidate) against a
  Server Action reading Postgres. Surface all eight metrics, **per-source yield chart first** (the feature
  no off-the-shelf tool gives me), plus the funnel/Sankey, resume-version conversion, time-to-first-response,
  and weekly velocity. Manual override buttons to re-trigger tailoring or force-approve.
- Fleet summary line updated, e.g. `report("jobs", ok=True, summary="22 submitted · 4 interviews · 1 offer · 3.1% rate")`.

**Tables touched:** `emails` (insert, `gmail_message_id UNIQUE`, `detected_status`), `events`
(insert/update with `gcal_event_id`), `applications` (status transitions), `pending_emails` (new).

**Done when:** rejection/confirmation/OA/interview emails auto-advance application status without me
touching them, confirmed interviews create calendar events, ghosted apps surface a drafted (un-sent)
follow-up, and the `/applications` page shows live funnel + per-source yield from Postgres.

---

## 6. Risks & open questions

**Risks (with the mitigation already baked into the plan):**
- **LinkedIn / Handshake account ban — HIGH, non-recoverable.** Both explicitly ban automation; LinkedIn
  litigated scraping and has < 15% ban recovery. *Mitigation: never automate either. Out of scope permanently.*
- **ATS silent disqualification — MEDIUM, invisible.** Greenhouse (CAPTCHA on), some Workday tenants
  (Cloudflare Turnstile), and DataDome/Imperva can flag headless browsers via fingerprinting, honeypots,
  or sub-human speed — you just never hear back. *Mitigation: prefer the public API submit paths; use real
  Chrome + stealth for autofill; randomize per-field delays (2–5s), not just per-submission.*
- **Greenhouse CAPTCHA wall blocks Tier 1 — MEDIUM.** *Mitigation: check the apply page before scripting;
  fall back to Tier 2 autofill.*
- **Hallucinated resume/cover-letter content — HIGH (career risk).** Invented metrics surface in interviews
  and can rescind offers. *Mitigation: the three-layer truthful-tailoring guardrail (prompt + Pydantic +
  preservation score) and the human diff gate.*
- **Quality degradation at volume — MEDIUM.** Generic output trains ATS screeners and recruiters to reject.
  *Mitigation: the > 0.65 qualification gate, per-company cover-letter grounding, and the human review gate
  checking for generic language.*
- **Workday direct scraping wastes engineering time — MEDIUM.** Akamai + shifting tenants/schemas.
  *Mitigation: no DIY scraper; managed Apify actor only for specific high-value targets if ever needed.*
- **Anthropic rate limits / spend — LOW–MEDIUM.** Tier 1 is 50 req/min, $100/day. *Mitigation: batch in
  10s with gaps, use Batch API overnight, hard spend cap, gate Opus behind an explicit confirm.*
- **Secret / key leakage — LOW but real.** *Mitigation: Vercel sensitive env vars, GitHub secrets, OS
  keychain, `.env.example` only; startup validator asserts presence + format (`ANTHROPIC_API_KEY` ~ `^sk-ant-`).*
- **GitHub API rate limit for event/commit polling — LOW.** Unauthed = 60/hr. *Mitigation: use a free PAT
  for 5,000/hr; `raw.githubusercontent.com` single-file pulls aren't strictly limited.*
- **Calendar privacy leak — LOW.** *Mitigation: events on a personal Google account, never berkeley.edu.*

**Open questions (resolve as I build):**
- Post-MVP, is there ever a case for true auto-submit on a narrow whitelist (e.g., Greenhouse no-CAPTCHA,
  match score > 0.9, one of my top-10 target companies)? Default answer stays **no** until the data proves
  quality holds.
- Telegram inline buttons vs. the dashboard as the primary approval surface — likely Telegram for speed,
  dashboard for review depth. Decide in Phase 4.
- Build my own local-only Playwright autofill vs. lean on Simplify Copilot? Trade-off is data privacy
  (Simplify stores my full profile on its servers, privacy policy last updated 2021) vs. build time.
  Start with Simplify for prototype speed; revisit a local build if privacy bites.
- Workable/Recruitee/Personio coverage — worth it, or do the GitHub feeds + JSearch already catch those
  startups? Measure after Phase 1 before investing.
- Near-duplicate dedup threshold tuning (MinHash 0.85? Levenshtein < 0.15?) — calibrate against real
  Phase 1 data.

---

## 7. Milestone checklist

- [ ] **Phase 0** — `ceos-jobs` scaffolded; `ceo_report.py` wired; `jobs` registered in `AGENTS` and
      rendering on the dashboard; six core tables created.
- [ ] **Phase 1** — GitHub feeds + top-100 ATS map + breadth query ingesting to `job_listings`;
      `dedup_key` UNIQUE constraint live; vanished listings marked inactive; daily run reports to the fleet.
- [ ] **Phase 2** — Master-profile YAML committed; JD parser + relevance classifier running; > 0.65
      qualification gate filtering; qualifying roles in `Queued` with skills-gap summaries; `jd_text` stored.
- [ ] **Phase 3** — Grounded tailoring pipeline with preservation-score gate; single-column RenderCV/Typst
      PDFs passing ats-screener; grounded cover-letter drafts; human diff gate enforced before `Ready`.
- [ ] **Phase 4** — Canonical application JSON profile; Tier-1 Greenhouse/Lever API submit (CAPTCHA-checked);
      Tier-2 autofill-then-confirm for Workday/Taleo/iCIMS/Ashby; pre-submission quality gate; no submit
      without a human click; results recorded.
- [ ] **Phase 5** — Read-only Gmail status ingestion advancing the nine-stage machine; Calendar events on
      OA/interview; 21-day ghosting follow-up drafts (un-sent); `/applications` page live in `ceos-enterprise`
      with per-source yield first; fleet summary reflecting real funnel numbers.
- [ ] **North-star check** — sustaining 15–25 quality apps/week at < 5 min each, with a measured
      application-to-interview rate > 3%.
