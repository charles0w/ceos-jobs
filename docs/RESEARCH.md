# Jobs — Research Report

This is the consolidated research backing **Jobs**, the personal recruitment agent in the
ceos-enterprise fleet. It exists so that future-me doesn't have to re-derive the landscape of
job-board APIs, ATS endpoints, and automation tradeoffs from scratch. Everything here is grounded
in the research digest; where a claim has a source, it's linked inline.

The agent's job is to ingest internship/new-grad listings relevant to a UC Berkeley
SWE/quant/data student, score and tailor against them, help submit, and track the whole pipeline
end to end. The recurring tension throughout is **automation reach vs. ToS/account-ban risk** — and
the honest answer is that the cheap, legal, high-signal path covers most of the value, while the
last mile (LinkedIn, Handshake, blind-blast submission) is where the risk lives and where humans
should stay in the loop.

The five sections below map to the five research areas. The closing **Synthesis** takes a clear
position on the architecture I'm actually going to build.

---

## 1. Listing acquisition

The highest-signal, lowest-risk ingestion strategy prioritizes three tiers in order:
(1) community-maintained GitHub JSON feeds that are already deduplicated and normalized, updated
daily with zero scraping; (2) public ATS JSON endpoints from Greenhouse, Lever, Ashby, Workable,
and Recruitee, which require no auth and are explicitly designed for third-party consumption; and
(3) commercial aggregator APIs (JSearch, Adzuna) for breadth. A well-designed pipeline can cover
roughly 80% of relevant tech internship postings without touching a single auth-walled page.

The platforms to avoid are the obvious-but-poisoned ones: LinkedIn has no usable job-search
developer API, Indeed deprecated its public consumer API, and Handshake is gated behind
institutional access. Scraping any of these is a meaningful ToS/account-ban risk. Workday and iCIMS
technically expose undocumented JSON endpoints but sit behind Akamai/enterprise WAFs and break
frequently — only worth it through a managed scraping service, and only for specific high-value
targets.

### Key findings

- **The SimplifyJobs feed is the single best starting point.** `SimplifyJobs/Summer2026-Internships`
  (jointly maintained by Pitt CSC and Simplify) stores all listings in
  `.github/scripts/listings.json` on the `dev` branch. Each record has `company_name`, `title`,
  `url` (direct ATS link), `locations`, `terms`, `date_posted` (Unix), `date_updated`, `active`,
  `is_visible`, `source`, and a unique `id`. Fetch the raw file with a no-auth HTTP GET at
  `https://raw.githubusercontent.com/SimplifyJobs/Summer2026-Internships/dev/.github/scripts/listings.json`.
  ([github.com](https://github.com/SimplifyJobs/Summer2026-Internships))
- **`vanshb03/New-Grad-2026` mirrors the same schema for new-grad full-time roles** (maintained by
  WeCracked/Resumes.fyi), with the raw URL pattern
  `https://raw.githubusercontent.com/vanshb03/New-Grad-2026/dev/.github/scripts/listings.json`.
  Quant roles (Jane Street, Citadel, Two Sigma, HRT) tend to appear here faster than on aggregators.
  ([github.com](https://github.com/vanshb03/New-Grad-2026))
- **`speedyapply/2026-SWE-College-Jobs` and `2026-AI-College-Jobs` are Markdown-only** (no JSON
  feed) with FAANG+/Quant tagging. Parsing means regex over the README table or, better, watching
  the commit diff for new rows. Use as a secondary signal to catch roles Simplify misses.
  ([github.com](https://github.com/speedyapply/2026-SWE-College-Jobs))
- **Greenhouse exposes a fully public, no-auth JSON board API:**
  `GET https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs?content=true`. The
  `board_token` is the slug from `boards.greenhouse.io/{token}`. Reads need no auth; only POST
  (application submission) requires Basic Auth. No published rate limit, but 5 concurrent requests
  is a safe ceiling. ([developers.greenhouse.io](https://developers.greenhouse.io/job-board.html))
- **Lever exposes a public v0 postings API with built-in filtering:**
  `GET https://api.lever.co/v0/postings/{clientname}?mode=json`, with query params including
  `team`, `department`, `location`, and — most useful here — `commitment` (full-time/internship).
  Client name is the slug from `jobs.lever.co/{clientname}`.
  ([github.com](https://github.com/lever/postings-api))
- **Ashby is the most structured no-auth ATS endpoint and returns compensation data:**
  `GET https://api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true` returns
  workplace type, employment type, publish date, descriptions, and full compensation objects.
  Many top AI/startup employers (Anthropic, Scale AI) use Ashby.
  ([developers.ashbyhq.com](https://developers.ashbyhq.com/docs/public-job-posting-api))
- **Workable and Recruitee extend coverage to European/mid-market companies** via no-auth JSON:
  `GET https://apply.workable.com/api/v1/widget/accounts/{clientname}` and
  `GET https://{clientname}.recruitee.com/api/offers`. Personio uses XML.
  ([fantastic.jobs](https://fantastic.jobs/article/ats-with-api))
- **Workday's internal API is technically reachable but is scraping, not a public API.** The
  `POST .../wday/cxs/{tenant}/External/jobs` pattern is protected by Akamai (single IPs blocked
  within minutes), uses inconsistent data centers (wd1/wd3/wd5/wd12), caps at 10,000 results, and
  needs a separate GET per posting. Use a managed scraper (Apify) only for specific targets. Meta,
  Google, and Amazon use Workday. ([jobspipe.dev](https://jobspipe.dev/blog/workday-api-guide))
- **iCIMS is effectively closed** — its Job Portal API needs a `customerId`/`portalId` that aren't
  publicly discoverable. Cover iCIMS companies (Microsoft, Lockheed Martin) via JSearch/Adzuna
  instead. ([developer-community.icims.com](https://developer-community.icims.com/applications/applicant-tracking/job-portal))
- **LinkedIn has no individual-accessible job API.** The Job Posting API requires LinkedIn Partner
  Program membership (incorporated companies only) and isn't accepting new partners. The hiQ v.
  LinkedIn case settled in 2022 with hiQ paying $500k plus a permanent injunction against scraping.
  ([natlawreview.com](https://natlawreview.com/article/hiq-and-linkedin-reach-proposed-settlement-landmark-scraping-case))
- **Indeed's consumer search API is gone** (deprecated 2022; XML feeds retiring 2025). The only
  official API is Job Sync, for employers pushing jobs *to* Indeed. Cover Indeed corpus via JSearch
  (which pulls Google for Jobs).
  ([dstribute.io](https://dstribute.io/news/navigating-the-new-indeed-xml-requirements-a-2025-implementation-guide/))
- **Handshake is gated and scraping is explicitly banned.** The EDU API is beta and restricted to
  career-services departments. As a Berkeley student, the Handshake account is a primary recruiting
  asset — do not automate it. ([joinhandshake.com](https://joinhandshake.com/legal/tos/))
- **JSearch (RapidAPI/OpenWeb Ninja) aggregates Google for Jobs in real time** (covering LinkedIn,
  Indeed, Glassdoor, and thousands of ATS boards). Free tier: 500 req/month, no card. Paid ~$20/mo
  for 10,000. Query e.g. `query='software engineer internship'&employment_types='INTERN'`.
  ([openwebninja.com](https://www.openwebninja.com/api/jsearch))
- **Adzuna is a genuinely free, officially documented REST API** covering the US + 16 countries:
  `GET https://api.adzuna.com/v1/api/jobs/{country}/search/{page}?app_id={id}&app_key={key}&what={query}`.
  Strong for non-FAANG, government/defense, and non-tech companies with SWE openings. ~1,000
  calls/day is reported safe. ([developer.adzuna.com](https://developer.adzuna.com/))
- **`jobright-ai` maintains category-specific GitHub repos** (2026-Internship, 2026-Engineer-Internship,
  2026-Data-Analysis-Internship) in Markdown-table format. The product itself claims 20,000+ new
  internship openings daily from 200,000+ career sites, but has no documented public API.
  ([github.com](https://github.com/jobright-ai/2026-Internship))
- **Managed scrapers exist for the hard ATS platforms but are pricey for an individual.** Apify
  actors run $5–15/run for Workday; jobdataapi.com starts at $295/month. Prefer the community feeds
  (which already aggregate many of these sources) and fall back to direct ATS polling only for
  uncovered targets. ([jobdataapi.com](https://jobdataapi.com/accounts/pricing/))

### Recommended tools

- **SimplifyJobs/Summer2026-Internships JSON feed** — daily, no-auth, structured; the single best
  source for SWE/data/AI/quant/PM internships.
- **vanshb03/New-Grad-2026 JSON feed** — same schema; best source for new-grad full-time.
- **Greenhouse Job Board API** (`boards-api.greenhouse.io/v1/boards/{token}/jobs?content=true`) —
  official public API; poll per target company.
- **Lever Postings API v0** (`api.lever.co/v0/postings/{slug}?mode=json&commitment=internship`) —
  official public API with a `commitment` filter to isolate internships.
- **Ashby Job Board API** (`api.ashbyhq.com/posting-api/job-board/{slug}?includeCompensation=true`) —
  returns salary data; essential for AI/startup coverage.
- **JSearch via RapidAPI** — Google for Jobs aggregation for breadth; free tier 500 req/month.
- **Adzuna API** — free REST API; good for non-FAANG and defense-contractor SWE roles.
- **requests + selectolax (Python)** — lightweight HTML parsing when no JSON API exists; 10–50x
  faster than BeautifulSoup on static pages.
- **Playwright (Python)** + playwright-stealth — for JS-heavy career pages where `requests` fails;
  stealth only for simple targets.
- **Apify Workday Jobs Scraper** — managed actor handling Akamai and tenant discovery; pay-per-use,
  reserved for specific high-value Workday employers.

### Risks & mitigations

- **LinkedIn scraping — HIGH, avoid entirely.** Account suspension, IP bans, and a litigated track
  record (hiQ settled $500k + permanent injunction). Cloudflare + proprietary bot detection blocks
  even paid proxies. A ban damages the *actual* job search. There is no legitimate individual API
  path. *Mitigation: never scrape; use the UI manually.*
- **Handshake scraping — HIGH (account ban).** ToS bans bots/crawlers/automated accounts. A ban
  removes Berkeley-exclusive postings and OCR access. The risk-reward is terrible. *Mitigation: log
  in manually 2–3x/week; never automate.*
- **Indeed scraping — MEDIUM risk, low reward.** Robust Cloudflare detection, ToS prohibition, and
  the data is mostly already in JSearch. *Mitigation: use JSearch instead.*
- **Workday direct scraping — MEDIUM risk, high maintenance.** Akamai kills DIY scrapers on
  residential IPs within minutes; tenant URLs and data-center assignments shift without notice. The
  practical cost is wasted engineering time. *Mitigation: use a managed Apify actor only for
  specific targets.*
- **Greenhouse/Lever/Ashby direct polling — LOW.** These APIs are built for public consumption. The
  only real risk is rate-limiting. *Mitigation: max one request per company per hour, batch calls,
  respect robots.txt.*
- **GitHub API rate limits — LOW.** `raw.githubusercontent.com` is unmetered for single files, but
  the REST API (events/commits) allows only 60 unauthenticated req/hour. *Mitigation: use a free
  personal access token for 5,000 req/hour.*
- **API key exposure (JSearch/Adzuna) — LOW.** A leaked key in a public repo means quota theft.
  *Mitigation: env vars / `.env`, never committed.*

---

## 2. Application submission

The 2025–2026 ATS landscape splits sharply: platforms with clean, documented POST endpoints
(Greenhouse, Lever, Ashby, SmartRecruiters) versus opaque browser-form-only systems (Workday,
Taleo, iCIMS). The first group is genuinely automatable from a stored candidate profile; the second
needs browser automation with real friction (account-creation walls, session timeouts, emerging bot
detection). LinkedIn Easy Apply is categorically off-limits.

The pragmatic architecture is **tiered**: direct API submission for Greenhouse/Lever where CAPTCHA
is absent; assisted autofill with a single human-confirm click for Workday/Taleo/iCIMS/Ashby/
SmartRecruiters; and a single canonical JSON profile that powers every layer. The strongest
argument against blind-blast automation isn't ToS — it's ROI: a documented case shows 5,000
applications yielding 20 interviews (0.5%). Quality at reasonable volume vastly outperforms this.

### Key findings

- **Greenhouse has a documented candidate-side POST endpoint:**
  `POST https://boards-api.greenhouse.io/v1/boards/{board_token}/jobs/{id}` accepts multipart form
  data (resume, education, employment, demographics, consent). Required fields are only
  `first_name`, `last_name`, `email`. The API key is proxied server-side; the candidate needs no
  credentials. The catch: employers can enable CAPTCHA on the hosted form, which blocks raw API
  calls and forces the form. This is the cleanest full-auto target *when CAPTCHA is absent*.
  ([developers.greenhouse.io](https://developers.greenhouse.io/job-board.html))
- **Lever's candidate POST endpoint is no-candidate-auth but rate-limited to 2 req/sec:**
  `POST /v0/postings/SITE/POSTING-ID?key=APIKEY`. Name and email are the only universally required
  fields; others are company-configured. Exceeding the limit returns 429. No CAPTCHA documented on
  the API path. ([github.com](https://github.com/lever/postings-api))
- **Ashby's `applicationForm.submit` is API-first but needs a `candidatesWrite` key** — not a
  no-auth path. The public *job board* GET API exposes job IDs and form specs without auth, but the
  realistic submission path for an individual is browser autofill against the hosted form.
  ([developers.ashbyhq.com](https://developers.ashbyhq.com/reference/applicationformsubmit))
- **SmartRecruiters' `POST /postings/:uuid/candidates` requires an `X-SmartToken`** — partner-only.
  Browser autofill against the hosted form is the realistic path.
  ([developers.smartrecruiters.com](https://developers.smartrecruiters.com/docs/application-api-1))
- **Workday is the single hardest ATS to automate** and covers a large share of SWE internships at
  large companies. Its wall is the "one company, one account" model (per-tenant username/password,
  email verification = an async human step), a 5–8 step wizard, ~15-minute session timeouts, and
  notoriously inaccurate resume parsing. The correct architecture (e.g.,
  `Workday-Application-Automator`) drives the wizard with Playwright + CDP and **pauses before final
  submit** — automate fill, human confirms.
  ([github.com](https://github.com/ubangura/Workday-Application-Automator))
- **Taleo and iCIMS are high-friction but weak on bot detection** — the barrier is UX complexity,
  not anti-bot tech. iCIMS forces account creation before viewing full details; Taleo has aggressive
  15-minute timeouts. Neither has a public POST endpoint, so browser automation is required.
  Simplify Copilot reports ~70% autofill accuracy here.
  ([aiapplyd.com](https://aiapplyd.com/blog/taleo-icims-worst-application-systems-2026))
- **LinkedIn Easy Apply automation is the highest-ban-risk action in the space.** User Agreement
  §8.2 prohibits bots/automation. In 2025 LinkedIn permanently banned Apollo.io and Seamless.ai, and
  added "human-impossible velocity" detection (flags 100+ applications/hour even if each looks
  legitimate). Enforcement escalates to permanent ban with <15% recovery. The account *is* the
  professional identity — losing it is catastrophic and asymmetric.
  ([linkedin.com](https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions))
- **Simplify Copilot is best-in-class assisted autofill and ToS-safe** because the human still
  clicks Submit. It stores a structured profile, detects the ATS, and maps fields across 100+
  platforms (~90% accuracy on Greenhouse/Lever, ~70% on Workday). The privacy caveat: a broad-
  permission extension sees every page visited, and the privacy policy was last updated in 2021.
  ([simplify.jobs](https://simplify.jobs/copilot))
- **Bot detection is behavioral, not just CAPTCHA.** Signals include sub-human completion speed,
  identical mouse-path signatures, headless user-agents, repeated IPs, and honeypot fields. Detected
  applicants are *silently* disqualified and sometimes flagged across departments — you never know.
  ([getjobs-ai.app](https://getjobs-ai.app/blog/how-companies-detect-and-disqualify-bot-assisted-application-submission))
- **Full-blast auto-apply bots show dismal ROI.** LazyApply holds 2.4/5 on Trustpilot (56%
  one-star) with documented 0.5% interview rates. FastApply's human-confirm "copilot mode" is a
  better model — fewer applications, higher quality.
  ([resumehog.com](https://resumehog.com/blog/posts/lazyapply-review-2026-is-the-job-search-bot-worth-the-hype.html))

### Recommended tools

- **Greenhouse Job Board API** — direct application POST; no candidate-side auth; best full-auto
  target when CAPTCHA is absent.
- **Lever Postings API** — POST apply; 2 req/sec; org key server-side; second-best full-auto target.
- **Simplify Copilot (Chrome extension)** — free autofill for 100+ ATS; ~90% on Greenhouse/Lever;
  human clicks submit (ToS-safe).
- **FastApply copilot mode** — browser autofill that pauses before submit and surfaces CAPTCHA
  interrupts to the user; ~$30–50/mo.
- **Playwright + playwright-stealth** — form-fill for Workday/Taleo/iCIMS; always pause before final
  submit.
- **fingerprint-suite** — realistic browser fingerprints to reduce bot signals if running automated
  browsing.
- **Ashby Public Job Board API (GET)** — enumerate jobs and fetch form-field specs; pair with
  browser autofill for submission.
- **Unified.to / Knit** — unified ATS API abstraction normalizing Greenhouse/Lever/Workable/Ashby;
  useful only if building a multi-ATS pipeline.

### Risks & mitigations

- **LinkedIn account ban — HIGH, non-recoverable.** Any Easy Apply automation violates §8.2; 2025
  velocity detection catches even well-spaced sessions. *Mitigation: never automate LinkedIn; use it
  manually.*
- **ATS silent disqualification — MEDIUM, invisible.** Fingerprinting, honeypots, and speed
  heuristics (Greenhouse CAPTCHA, Workday Cloudflare Turnstile, DataDome/Imperva). *Mitigation:
  stealth plugins, randomized 2–5s delays between fields, a real Chrome profile over headless.*
- **Greenhouse CAPTCHA wall — MEDIUM, blocks Tier 1.** When reCAPTCHA is enabled on the hosted form,
  API submissions are rejected for lacking the token. *Mitigation: load the apply page first; fall
  back to assisted autofill if CAPTCHA is present.*
- **Lever 429s — LOW.** *Mitigation: exponential backoff, ≥0.6s spacing; 10–15 apps/day is well
  within limits.*
- **Quality degradation at volume — MEDIUM, career risk.** Generic canned answers are detectable by
  recruiters and train ATS screeners to reject. *Mitigation: LLM-customize the 2–3 long-form answers
  per application; keep structured fields automated.*
- **Third-party autofill privacy — LOW/MEDIUM.** Simplify stores full work history, EEO data, and
  resume on vendor servers under a 2021-era policy. *Mitigation: review the policy, or build a local-
  only Playwright autofill reading from the local JSON profile.*
- **Ashby key leakage — LOW (if using autofill).** A `candidatesWrite` key grants write access to
  candidate records and must never be client-side. *Mitigation: use browser autofill against the
  hosted form; no candidate-side key needed.*

---

## 3. Tracking & management

The state of the art for personal pipeline management is a thin custom database (Postgres or SQLite
locally; Supabase hosted) with a fine-grained status machine, Gmail API polling for automatic status
ingestion, Google Calendar API for OA/interview events, and an LLM for email classification instead
of brittle regex. Commercial trackers (Teal, Huntr, Simplify) demonstrate the canonical feature set
but **none** auto-ingest rejection emails or compute per-source yield — which is exactly why a custom
tracker is worth building.

The automation boundary: discovery-through-submission can be fully automated, while interview
scheduling replies and offer negotiation must stay human-in-the-loop. The key metrics that let a
Berkeley student A/B test resumes and channels are application-to-interview rate (target >3%),
per-source yield, and time-to-first-response.

### Key findings

- **A nine-stage status machine is the right model.** Commercial trackers collapse to 5 stages; an
  automated system needs: Discovered → Queued → Tailoring → Ready → Submitted → OA/Assessment →
  Interviewing → Offer → Closed (Rejected | Ghosted | Declined). Use a forward-only `STATUS_RANK` to
  prevent regressions and write-protect terminal states.
  ([medium.com](https://medium.com/@bangadpurva/i-built-an-ai-that-reads-my-gmail-and-tracks-every-job-application-automatically-a9dafca7a66b))
- **Five core tables.** `companies`, `roles`, `applications`, `events`, `emails`. The `applications`
  table carries a generated `dedup_key` =
  `lower(trim(company))||'|'||lower(trim(title))||'|'||lower(trim(location))`, plus
  `resume_version`, `source_channel`, and `referral`. `events` links OAs/interviews to a
  `gcal_event_id`; `emails` keys on a `UNIQUE gmail_message_id`.
- **Dedup is a normalized composite key, with fuzzy matching for near-duplicates.** Exact-key dedup
  (lowercase+strip of company/title/location) catches cross-source exact dupes. For "Software
  Engineer Intern" vs "SWE Intern 2025", use MinHash LSH (datasketch) or embeddings; at personal
  volume (<2000 roles/cycle), exact key first then Levenshtein <0.15 within the same company is
  enough.
  ([textkernel.com](https://www.textkernel.com/learn-support/blog/online-job-postings-have-many-duplicates-but-how-can-you-detect-them-if-they-are-not-exact-copies-of-each-other/))
- **Gmail API + LLM classification beats regex.** Use the `gmail.readonly` scope, search on
  application/interview/offer/rejection/assessment keywords, fetch metadata + first 600 chars, and
  pass batches of up to 50 to Claude with a tool definition enforcing a status ENUM. Each extraction
  is independent, so one bad email can't contaminate the batch. Run 3x daily via APScheduler/cron.
  ([medium.com](https://medium.com/@bangadpurva/i-built-an-ai-that-reads-my-gmail-and-tracks-every-job-application-automatically-a9dafca7a66b))
- **Keyword priors for a regex fallback / cost reducer.** Confirmation: "application received",
  "thank you for applying". Rejection: "we regret", "move forward with other candidates", "position
  has been filled". OA: "HackerRank", "Codility", "online assessment", "coding challenge".
  Interview: "schedule a call", "phone screen", "Calendly", "Zoom link". Use these as a prior so the
  LLM only handles ambiguous cases.
  ([medium.com](https://medium.com/@tatevdoesdata/automating-my-job-search-with-gmail-api-fd1f728d1e8d))
- **Google Calendar integration on status transitions.** On `oa_scheduled`/`interview_scheduled`,
  LLM-extract the datetime and call `events.insert()` with a `colorId` (blue=OA, green=interview,
  red=deadline) and two reminders (24h, 1h). Store the returned `gcal_event_id` for later updates.
  ([n8n.io](https://n8n.io/workflows/5001-interview-scheduling-automation-with-google-sheets-calendar-gmail-and-gpt-4o/))
- **Follow-up scheduling rules.** Submitted with no inbound after ~14 days (21 for slower
  internship/new-grad cycles) → flag as ghosted and draft (not auto-send) a follow-up. OA deadlines
  → remind 3 days prior. Interviews → generate a prep brief 48h before from the stored JD text.
  ([medium.com](https://medium.com/@bangadpurva/i-built-an-ai-that-reads-my-gmail-and-tracks-every-job-application-automatically-a9dafca7a66b))
- **The commercial tools and their gaps.** Teal (keyword gap analysis, free unlimited tracking),
  Simplify (best volume autofill), Huntr (best CRM/contacts). The gap shared by all three: no
  per-source yield analytics, no resume A/B tracking, no Gmail auto-ingestion of rejections, no
  Calendar event creation. ([scale.jobs](https://scale.jobs/blog/teal-vs-simplify-job-tracker-comparison))
- **Dashboard metrics and benchmarks.** App-to-interview rate (<2% = a problem, 2–5% workable, >5%
  strong; 3% median), response rate, interview-to-offer (~47.5% NACE), per-source yield (referral/
  direct typically 2–3x LinkedIn), time-to-first-response, resume-version conversion, funnel drop,
  weekly velocity. Streamlit or Observable Framework are right-sized.
  ([jobshinobi.com](https://www.jobshinobi.com/blog/how-to-track-job-search-metrics-applications-to-interviews))
- **The automation boundary.** Automatable: ingest, dedup, status tracking, confirmation parsing,
  calendar creation, follow-up *drafting*, prep briefs, metrics. Human-in-the-loop: resume/CL review
  before submission, approving follow-ups, scheduling replies, negotiation. The LLM drafts but never
  auto-sends outbound to recruiters — one hallucinated detail can torpedo a candidacy.

### Recommended tools

- **PostgreSQL (Supabase free tier or local)** — the 5-table schema with a generated `dedup_key`;
  Supabase adds a free REST API and hosted dashboard.
- **google-api-python-client + google-auth-oauthlib** — Gmail (`gmail.readonly`) and Calendar
  (`calendar.events`) under one OAuth flow.
- **Anthropic Python SDK** with a Claude model via tool-use — email classification with an enforced
  status ENUM; ~$0.003 per 50-email batch at Sonnet pricing.
- **APScheduler** — in-process scheduling for 3x-daily polls, ghosting checks, and prep generation;
  no external cron infra.
- **datasketch (MinHash LSH)** — fuzzy near-duplicate detection (threshold ~0.85 on 3-gram shingles).
- **sentence-transformers (all-MiniLM-L6-v2)** — local semantic title similarity as a dedup fallback.
- **Streamlit** — fastest interactive analytics dashboard (funnel via plotly, per-source bars,
  Kanban table); localhost, no hosting cost.
- **n8n** — no-code Gmail→label automation and Calendar event creation, with prebuilt templates.
- **simplegmail** — thin Gmail wrapper for the prototype before switching to raw
  google-api-python-client.
- **spaCy en_core_web_sm** — NER for company/title extraction where LLM classification is overkill.

### Risks & mitigations

- **Gmail API ToS — LOW with the right scope.** `gmail.readonly` is fully compliant. *Mitigation: do
  NOT use `gmail.modify`/`gmail.send` for auto-sending to recruiters — that risks spam flags and
  account suspension.*
- **Greenhouse applicant-side ToS — relevant here.** Greenhouse prohibits "automated means …
  spiders, robots, crawlers" to access the Services, so headless submission through Greenhouse-hosted
  pages is ToS-violating. *Mitigation: use Simplify's human-assisted extension or apply manually.*
- **LinkedIn ToS — gray zone for Easy Apply extensions; HIGH for scraping.** *Mitigation: use Easy
  Apply extensions conservatively (<20/day) or not at all; never scrape profiles; never store
  LinkedIn profile data.*
- **Workday/Lever/iCIMS applicant-side — rate limits are the operative constraint.** >~10 apps/hour
  to one vendor may trip abuse detection. *Mitigation: random 30–120s jitter between submissions.*
- **Mass-applying reputational risk — MEDIUM.** Applying to clearly-unqualified roles can flag your
  email as low-quality across a vendor's entire customer base (Workday spans thousands of employers).
  *Mitigation: an LLM qualification gate (match score >0.65) before a role enters Queued.*
- **OAuth token storage — handle carefully.** *Mitigation: encrypt refresh tokens at rest (Fernet or
  OS keychain via `keyring`); never commit; rotate on suspicious access.*
- **Calendar privacy — LOW.** Events on a `berkeley.edu` Workspace account may sync to admin-visible
  calendars. *Mitigation: create events on a personal Google account.*

---

## 4. Resume tailoring

LLM-based resume tailoring is genuinely automatable for the content-rewriting and keyword-surfacing
steps, but requires a **mandatory human-in-the-loop review before any submission** to prevent
hallucination and subtle misrepresentation. ATS parsing is now two layers: technical formatting
compliance (single-column, no tables, standard headings, text-based PDF/DOCX) and semantic keyword
alignment — and modern systems penalize keyword stuffing above ~85% density as much as they reward
relevance.

The practical self-hosted architecture: a structured YAML/JSON master profile as the single source
of truth, an LLM layer for bullet rewriting strictly grounded to that source, and RenderCV/Typst for
deterministic PDF output — with a human review gate before any generated file is used. Cover letters
are highly automatable when company research is scraped per-listing, but still need human review for
tone and accuracy.

### Key findings

- **Single-column is the only safe choice for Workday and Taleo.** Workday reads strictly
  left-to-right, top-to-bottom; sidebars get appended to the bottom. Tables are universally
  dangerous (Taleo scrambles cells, Workday merges them, iCIMS strips them). Single-column scored
  93% vs two-column's 86% in testing. The safe kit: single column, standard headings, simple bullets,
  inline contact info (no header/footer), both acronym and full form, consistent dates, no graphics.
  ([atshiring.com](https://www.atshiring.com/en/learn/workday-ats-guide-2025))
- **Modern ATS uses NLP and penalizes stuffing above ~85–90% match density.** They understand
  synonyms, so variant-stuffing is useless; scores that high read as over-optimization. Embed
  keywords contextually inside achievement bullets. Skills-based screening now precedes title-based
  review at 60%+ of enterprise hirers, so an accurate Skills section matters more than it used to.
  ([atshiring.com](https://www.atshiring.com/en/learn/workday-ats-guide-2025))
- **Tailoring without anti-hallucination guardrails is a liability.** LLMs invent metrics, fabricate
  technologies, and over-claim experience. The ResumeFlow approach measures content preservation
  (overlap/semantic similarity) and flags heavy modification before acceptance. Required guardrails:
  (1) a system prompt restricting to source facts, (2) Pydantic-schema output for field-level
  grounding, (3) content-preservation scoring, (4) human diff review before any file is saved.
  ([arxiv.org](https://arxiv.org/html/2402.06221v1))
- **The master resume should be structured YAML/JSON, not a living Word doc.** An experience bank
  with 4–6 bullets per role, each tagged with skills (`tags: [Python, ML, data-pipeline]`), plus a
  metadata file of all technologies, projects, and a freeform `context` field per project. RenderCV
  implements exactly this: YAML data + Typst template = pixel-perfect, git-versionable PDF, with
  GitHub Actions CI. ([github.com](https://github.com/rendercv/rendercv))
- **Typst is the right rendering backend; LaTeX is legacy for this.** Typst compiles far faster with
  a first-class scripting layer (loops, conditionals, data imports), so a template can read JSON/YAML
  and conditionally render sections by JD tag. RenderCV uses Typst and produces ATS-parseable
  single-column PDFs. ([aarol.dev](https://aarol.dev/posts/typst-cv/))
- **The pipeline: JD parse → gap analysis → grounded rewrite → human diff → render.** (1) JD parser
  → structured `required_skills`/`preferred_skills`/`role_level`/`domain_keywords`. (2) Gap analysis
  vs master tags. (3) Per-bullet rewriter ("use only facts from the source bullet; add no metrics not
  present"). (4) Tag-based section selector. (5) Content-preservation check (`SequenceMatcher` or
  semantic similarity; flag <0.70). (6) Human diff gate. (7) Render via `rendercv render` or the
  Typst CLI. ([arxiv.org](https://arxiv.org/html/2402.06221v1))
- **Cover letters are automatable with per-listing research and a tone review.** Scrape the
  company's About/blog, then prompt for a 3-paragraph letter (company-specific hook → one concrete
  STAR story → forward-looking close) grounded only in the profile. Every letter must be read aloud
  before submission — robotic "I am excited to leverage my synergistic skill set" prose hurts more
  than no letter. ([github.com](https://github.com/DoubleGremlin181/cover-letter-llm))
- **Jobscan is a sanity check, not a strategy.** ~70–80% keyword-matching accuracy; it can't
  replicate company-specific ATS weights and over-recommends soft skills (which recruiters flag as
  padding). The open-source `sunnypatell/ats-screener` simulates Workday/Taleo/iCIMS/Greenhouse/
  Lever/SuccessFactors parsing locally and free.
  ([github.com](https://github.com/sunnypatell/ats-screener))
- **Tailoring itself carries zero ToS risk; submitting via bot does not.** Parsing a JD, rewriting
  bullets, and generating a PDF touch no platform. The risk begins at submission. The only ToS-safe
  architecture keeps automation in the *prepare* phase and a human in the *submit* phase.
  ([connectsafely.ai](https://connectsafely.ai/articles/is-linkedin-automation-safe-tos-scraping-guide-2026))

### Recommended tools

- **RenderCV** — YAML-in / Typst-PDF-out, git-versionable master resume with CI; the rendering
  backbone.
- **Typst CLI** — programmatic PDF compilation with native data import; ATS-safe single-column
  templates (simple-technical-resume, modern-cv).
- **Claude (Sonnet for routine tailoring, Opus for final polish) or GPT-4o** — natural prose +
  STAR-format bullets; use structured (Pydantic) outputs for grounded extraction.
- **Pydantic v2** — enforces structured LLM output; field descriptions act as embedded sub-prompts.
- **sentence-transformers / difflib.SequenceMatcher** — content-preservation scoring before the
  review gate.
- **sunnypatell/ats-screener** — free local ATS parsing simulation for smoke-testing PDFs.
- **Jobscan** — free trial only, for one-time calibration; do not pay recurring.
- **WeasyPrint** — HTML-to-PDF fallback if Typst isn't desired (less deterministic).
- **firecrawl / httpx + BeautifulSoup** — per-listing company research for cover-letter
  personalization.

### Risks & mitigations

- **Hallucination — HIGHEST priority.** Invented metrics ("40% latency reduction") or fabricated
  scope ("led a team of 8") is misrepresentation that surfaces in interviews and can get offers
  rescinded. *Mitigation: strict system-prompt constraints, Pydantic schemas, content-preservation
  scoring, mandatory human diff review.*
- **ToS on platforms.** Workday/Greenhouse/iCIMS/Taleo prohibit scripted submission; LinkedIn
  prohibits scraping/bot actions. *Mitigation: keep all automation in the offline prepare phase;
  humans submit manually.*
- **Keyword-stuffing detection — MEDIUM.** Scores >85–90% read as over-optimized; adding skills you
  lack is misrepresentation. *Mitigation: surface only real skills, embed contextually, never use
  white-text keyword blocks (detectable).*
- **PDF formatting failures — MEDIUM.** Multi-column or table-laden PDFs parse as garbage in
  Workday/Taleo and score zero, silently. *Mitigation: single-column Typst/RenderCV only; run
  outputs through ats-screener; test DOCX for Workday-heavy targets.*
- **Generic output — MEDIUM.** Near-identical resumes read as templates and get deprioritized.
  *Mitigation: a human review gate that checks for generic language; include company/team context in
  the prompt.*
- **Model non-determinism.** The same prompt yields different bullets, so a reviewed resume can't be
  regenerated identically. *Mitigation: save full before/after LLM output keyed by JD hash + profile
  version; never regenerate — reuse the reviewed version.*

---

## 5. Agent architecture

The agent runs on the existing ceos-enterprise stack: Next.js 15, Vercel Postgres, Vercel Cron, and
Python. Roughly 70% of the pipeline — ingest, dedup, scoring, tailoring, tracking, notifications —
can be automated; the remaining 30% (final approval before submission, custom essays, portfolio
uploads) stays human-in-the-loop. Vercel Fluid Compute handles orchestration and LLM calls, but all
scraping and long browser automation must live in a separate Python worker (GitHub Actions, a small
$7/mo box, or Vercel Workflows). A Postgres-backed queue with `SELECT ... FOR UPDATE SKIP LOCKED` is
the right queue primitive; a Telegram bot with inline approve/skip/rewrite buttons is the
lowest-friction human-in-the-loop surface, paired with an `/applications` page on the dashboard.

### Key findings

- **Vercel Fluid Compute allows up to 800s/invocation (Pro), but scraping can't run there.** The
  default is 300s; Pro Cron allows up to 40 jobs at 1-minute intervals. Functions are stateless with
  no persistent filesystem — unsuited for multi-minute Playwright sessions.
  ([vercel.com](https://vercel.com/docs/functions/limitations))
- **Vercel Workflows (GA Oct 2025) is the correct durable agent-loop primitive on this stack.** Each
  step runs as a separate invocation that can pause for minutes-to-months and resumes
  deterministically, each with its own 800s budget and automatic retry. The AI SDK `DurableAgent`
  splits an N-step LLM loop into N invocations — removing the need for a home-rolled Postgres state
  machine for orchestration. ([vercel.com](https://vercel.com/docs/workflows))
- **Scraping belongs in GitHub Actions (free) or a small always-on worker, not Vercel functions.**
  `python-jobspy` scrapes LinkedIn/Indeed/Glassdoor/ZipRecruiter/Google Jobs concurrently (LinkedIn
  rate-limits ~10 pages/IP — proxies essential). Greenhouse/Lever public JSON endpoints need no
  proxies and no ToS gray area. GitHub Actions free tier (2,000 min/mo) easily covers 2–4 daily
  runs; a $7/mo Render/Railway box is the upgrade path for sub-hourly freshness or persistent
  Playwright. ([github.com](https://github.com/speedyapply/JobSpy))
- **Postgres with `SELECT ... FOR UPDATE SKIP LOCKED` is the right queue.** A `jobs` table (id,
  status ENUM, payload JSONB, attempts, next_attempt_at, created_at) with `SKIP LOCKED` is crash-safe
  (locks release on worker death) and handles 50K jobs/hour — far more than needed. Vercel KV is
  deprecated; its successor Upstash Redis fits ephemeral data (dedup hashes with TTL, rate-limit
  counters, approval-pending sets) but not durable job state.
  ([netdata.cloud](https://www.netdata.cloud/academy/update-skip-locked/))
- **LLM task assignment by tier.** Haiku for binary relevance classification, dedup, and structured
  field extraction from raw HTML; Sonnet for JD parsing, bullet-level resume tailoring, and
  first-draft cover letters; Opus (1M-token context) reserved for final cover-letter polish and any
  custom 500-word essay needing the full JD + resume + research in one call. The Batch API gives 50%
  off for overnight processing. Rough per-application cost: Haiku ~$0.001, Sonnet ~$0.05, Opus
  ~$0.15. ([platform.claude.com](https://platform.claude.com/docs/en/about-claude/models/overview))
- **Telegram inline buttons are the lowest-friction human-in-the-loop design.** One message per job
  with company, role, resume diff, and cover-letter preview, plus Approve / Skip / Rewrite (Rewrite
  re-queues for Opus). The dashboard's `/applications` page is the secondary review surface, reading
  Postgres with SSE or SWR polling.
  ([dev.to](https://dev.to/sai_22/i-built-a-telegram-based-ai-career-agent-with-hermes-agent-98n))
- **ATS submission realistically needs Playwright for Workday/iCIMS.** Greenhouse and Lever have
  public apply endpoints (low ban risk, no browser); Workday/iCIMS/Taleo cover ~78% of Fortune 1000
  with no public apply API. Open-source `simonfong6/auto-apply` and ApplyPilot demonstrate
  Playwright-based submission. Unified.to covers 62+ ATS but targets enterprise recruiters (likely
  expensive). ([unified.to](https://unified.to/blog/how_to_build_candidate_sourcing_across_greenhouse_lever_workday_and_60_ats_platforms_with_a_unified_api))
- **Secrets handling: Vercel sensitive env vars server-side; never in the client bundle.** Store
  `ANTHROPIC_API_KEY`, `DATABASE_URL`, Upstash creds, and `TELEGRAM_BOT_TOKEN` as sensitive env vars
  (not committed `.env`). The GitHub Actions worker uses repository secrets. Validate keys on startup
  (e.g., `ANTHROPIC_API_KEY` matches `/^sk-ant-/`); keep a valueless `.env.example`.
  ([vercel.com](https://vercel.com/docs/environment-variables/sensitive-environment-variables))

### Build sequence

- **Phase 1 (wk 1–2):** Scaffold the Postgres schema (jobs, applications, resume_versions) and the
  SKIP LOCKED worker. Wire JobSpy into a GitHub Actions workflow at 06:00/18:00 UTC; POST new jobs to
  a Next.js API route. Add a Haiku relevance classifier inline (under $0.002 per batch of 20).
- **Phase 2 (wk 3–4):** Build the Vercel Workflow for scoring/tailoring: fetch JD+resume → Sonnet
  skills-gap + bullet tailoring → optional Opus cover-letter polish → write artifacts back, set
  `status='pending_approval'`. Trigger from a 15-minute Cron polling `status='classified_relevant'`.
- **Phase 3 (wk 5–6):** Telegram notification step (resume diff + CL preview, Approve/Skip/Rewrite).
  On Approve, call Greenhouse/Lever API directly, or enqueue a Playwright task for Workday/iCIMS via
  a Postgres row. Track confirmation ID + timestamp.
- **Phase 4 (wk 7–8):** Add the `/applications` page to ceos-enterprise (SWR, 10s revalidation) with
  company/role/source/status/score/submitted_at/response columns and a manual override.

### Queue & model specifics

- **Queue:** single `jobs` table; key columns id UUID, source, external_id, raw_jd, status
  (ingested|classified|tailored|pending_approval|approved|submitted|rejected|offer),
  tailored_resume_url, cover_letter, classification_score, attempts, next_attempt_at, created_at.
  `UNIQUE(source, external_id)` prevents duplicates; a partial index on
  `status WHERE status NOT IN ('submitted','rejected')` speeds polling.
- **Cost estimate:** ~50 relevant JDs/day + 10 approvals/day ≈ $4.05/day (~$120/mo); Batch API on
  the Sonnet pass brings it to ~$80/mo. Set hard spend limits in the Anthropic console.

### Recommended tools

- **python-jobspy** — multi-board scraper; rotate proxies for LinkedIn.
- **Vercel Workflows** — durable orchestration loop, avoiding the 800s ceiling.
- **Vercel Postgres (Neon) + SKIP LOCKED** — durable queue, state store, tracking DB.
- **Upstash Redis** (Vercel KV replacement) — dedup bloom filter, rate-limit counters, approval TTL
  sets.
- **Anthropic API (Haiku / Sonnet / Opus)** + **Batch API** — tiered classification → tailoring →
  polish, 50% off overnight.
- **Playwright (Python)** in GitHub Actions or a $7/mo Render worker — Workday/iCIMS form submission.
- **python-telegram-bot / telegraf** — inline-button human approval.
- **Greenhouse / Lever apply APIs** — direct, browserless, lowest-ban-risk submission.
- **GitHub Actions scheduled workflows** — free scraping runtime (cron `0 6,18 * * *`).
- **Resend / Postmark** — transactional confirmation + weekly digest email.

### Risks & mitigations

- **LinkedIn ToS — HIGH.** §8.2 prohibits scraping; jobspy uses unofficial endpoints. *Mitigation:
  scrape anonymously (no session cookie), <1 req/3s, rotating residential proxies, ≤100 jobs/day —
  and prefer Greenhouse/Lever public JSON where possible.*
- **Indeed/ZipRecruiter ToS — MEDIUM.** Both prohibit scraping; Indeed has minimal rate limiting in
  practice. *Mitigation: proxy + user-agent rotation, low rate.*
- **ATS ban risk for form submission — MEDIUM.** Timing analysis, honeypots, and Cloudflare/DataDome
  (Workday on some instances) detect bots; expect ~5–10% of Workday submissions to fail on CAPTCHA.
  *Mitigation: human-speed typing (50–150ms/keystroke), randomized field order, residential IP, and
  a "manual required" fallback status.*
- **Anthropic rate limits — MEDIUM.** Tier 1 is 50 req/min and $100/day; a burst of 50 simultaneous
  JDs trips it. *Mitigation: batches of 10 with 2s gaps, or Batch API, or upgrade to Tier 2.*
- **Greenhouse/Lever API misuse — LOW.** The apply endpoints are genuinely public; 1–3 apps/day per
  company is indistinguishable from manual use. *Mitigation: enforce `UNIQUE(company, external_id)`;
  never submit duplicates.*
- **Data privacy — LOW/MEDIUM.** Resume PII goes to the Anthropic API (no training on API data by
  default). *Mitigation: review the data-handling policy, consider redacting PII before calls, and
  store full resume text in Postgres (restricted) rather than Upstash.*
- **GitHub Actions free-tier exhaustion — LOW.** Two ~5-min HTTP scrape runs ≈ 300 min/mo;
  Playwright runs (20–30 min) burn faster. *Mitigation: keep scraping HTTP-only; run Playwright from
  the always-on worker.*
- **Postgres connection limits — LOW.** Neon free allows 20 concurrent connections; parallel
  Workflow steps can exhaust the pool. *Mitigation: use the pgBouncer pooler endpoint
  (`?pgbouncer=true`), pool size 5/instance.*

---

## Synthesis: the recommended approach

After weighing reach against risk across all five areas, the position is clear and opinionated.

**Ingestion: prefer public JSON feeds + ATS public board endpoints; treat everything else as a
fallback.** The daily community feeds (`SimplifyJobs/Summer2026-Internships`, `vanshb03/New-Grad-2026`)
plus per-company polling of Greenhouse, Lever, and Ashby public board APIs cover ~80% of relevant
postings with zero scraping risk and clean, structured data. JSearch (free tier) and Adzuna fill
breadth gaps. LinkedIn, Indeed, and Handshake are not ingested by the agent — the account-ban and
litigation risk is asymmetric and permanent, and they add little the feeds don't already surface.
Workday is reached only through a managed Apify actor, and only for a short list of high-value
targets.

**Submission: assisted-autofill-with-human-confirm is the default; direct API only for the clean,
CAPTCHA-free cases.** Greenhouse and Lever get direct API submission when no CAPTCHA is present
(Tier 1, rate-limited and capped at ~10–15/day). Everything else — Workday, Taleo, iCIMS, Ashby,
SmartRecruiters — uses Simplify Copilot or a local Playwright autofill that *pauses before submit*
(Tier 2). LinkedIn Easy Apply is never automated. The 0.5%-at-5,000-applications data point is the
governing argument: this agent optimizes interview conversion, not application count, and a human
always clicks the final button.

**Tailoring: truthful, master-profile-driven, with a hard review gate.** A single YAML/JSON master
profile is the only source of truth; the LLM may rephrase and reorder but never invent metrics,
tools, or scope. Content-preservation scoring flags drift, RenderCV/Typst produces single-column
ATS-safe PDFs verified against `ats-screener`, and nothing reaches a submission step without a human
diff review. Hallucination is the single highest-priority risk in the whole system because it
threatens the candidate's credibility in interviews and offer integrity.

**Pipeline: a Postgres-backed, human-in-the-loop machine on the existing Vercel stack.** Vercel
Postgres (`SKIP LOCKED` queue) is the durable store and state machine; Vercel Workflows orchestrates
the scoring/tailoring loop; GitHub Actions runs all scraping; Upstash Redis holds ephemeral dedup and
rate-limit state; a Telegram bot is the approval surface; and the ceos-enterprise dashboard's
`/applications` page is the analytics view. Gmail (`readonly`) auto-ingests status; Google Calendar
auto-creates OA/interview events; the agent *drafts* follow-ups but never auto-sends to recruiters.
The two features no commercial tracker offers — rejection-email auto-ingestion and per-source yield
analytics — are the reason this is worth building rather than buying.

The throughline: automate the legal, low-risk, high-leverage 70% aggressively; keep a human on the
final submit, the recruiter-facing outbound, and anything touching LinkedIn or Handshake. That line
is where reach stops being worth the risk.

---

## Sources

- SimplifyJobs/Summer2026-Internships — https://github.com/SimplifyJobs/Summer2026-Internships
- vanshb03/New-Grad-2026 — https://github.com/vanshb03/New-Grad-2026
- speedyapply/2026-SWE-College-Jobs — https://github.com/speedyapply/2026-SWE-College-Jobs
- Greenhouse Job Board API — https://developers.greenhouse.io/job-board.html
- Lever Postings API — https://github.com/lever/postings-api
- Ashby Public Job Posting API — https://developers.ashbyhq.com/docs/public-job-posting-api
- Ashby applicationForm.submit — https://developers.ashbyhq.com/reference/applicationformsubmit
- SmartRecruiters Application API — https://developers.smartrecruiters.com/docs/application-api-1
- ATS with API (Workable/Recruitee/Personio) — https://fantastic.jobs/article/ats-with-api
- Workday API guide — https://jobspipe.dev/blog/workday-api-guide
- iCIMS Job Portal API — https://developer-community.icims.com/applications/applicant-tracking/job-portal
- hiQ v. LinkedIn settlement — https://natlawreview.com/article/hiq-and-linkedin-reach-proposed-settlement-landmark-scraping-case
- Indeed XML requirements 2025 — https://dstribute.io/news/navigating-the-new-indeed-xml-requirements-a-2025-implementation-guide/
- Handshake ToS — https://joinhandshake.com/legal/tos/
- JSearch (OpenWeb Ninja) — https://www.openwebninja.com/api/jsearch
- Adzuna Developer API — https://developer.adzuna.com/
- jobright-ai/2026-Internship — https://github.com/jobright-ai/2026-Internship
- jobdataapi pricing — https://jobdataapi.com/accounts/pricing/
- Workday-Application-Automator — https://github.com/ubangura/Workday-Application-Automator
- Taleo/iCIMS application systems — https://aiapplyd.com/blog/taleo-icims-worst-application-systems-2026
- LinkedIn prohibited software — https://www.linkedin.com/help/linkedin/answer/a1341387/prohibited-software-and-extensions
- Simplify Copilot — https://simplify.jobs/copilot
- ATS bot detection — https://getjobs-ai.app/blog/how-companies-detect-and-disqualify-bot-assisted-application-submission
- LazyApply review 2026 — https://resumehog.com/blog/posts/lazyapply-review-2026-is-the-job-search-bot-worth-the-hype.html
- AI-reads-Gmail job tracker (bangadpurva) — https://medium.com/@bangadpurva/i-built-an-ai-that-reads-my-gmail-and-tracks-every-job-application-automatically-a9dafca7a66b
- Gmail API job-search automation (tatevdoesdata) — https://medium.com/@tatevdoesdata/automating-my-job-search-with-gmail-api-fd1f728d1e8d
- Textkernel duplicate detection — https://www.textkernel.com/learn-support/blog/online-job-postings-have-many-duplicates-but-how-can-you-detect-them-if-they-are-not-exact-copies-of-each-other/
- n8n interview scheduling automation — https://n8n.io/workflows/5001-interview-scheduling-automation-with-google-sheets-calendar-gmail-and-gpt-4o/
- Teal vs Simplify comparison — https://scale.jobs/blog/teal-vs-simplify-job-tracker-comparison
- Job search metrics — https://www.jobshinobi.com/blog/how-to-track-job-search-metrics-applications-to-interviews
- Workday ATS guide 2025 — https://www.atshiring.com/en/learn/workday-ats-guide-2025
- ResumeFlow paper — https://arxiv.org/html/2402.06221v1
- RenderCV — https://github.com/rendercv/rendercv
- Typst CV — https://aarol.dev/posts/typst-cv/
- cover-letter-llm — https://github.com/DoubleGremlin181/cover-letter-llm
- sunnypatell/ats-screener — https://github.com/sunnypatell/ats-screener
- LinkedIn automation/ToS guide — https://connectsafely.ai/articles/is-linkedin-automation-safe-tos-scraping-guide-2026
- Vercel Functions limitations — https://vercel.com/docs/functions/limitations
- Vercel Workflows — https://vercel.com/docs/workflows
- python-jobspy (JobSpy) — https://github.com/speedyapply/JobSpy
- Postgres SKIP LOCKED — https://www.netdata.cloud/academy/update-skip-locked/
- Anthropic models overview — https://platform.claude.com/docs/en/about-claude/models/overview
- Telegram AI career agent (Hermes) — https://dev.to/sai_22/i-built-a-telegram-based-ai-career-agent-with-hermes-agent-98n
- Unified.to candidate sourcing — https://unified.to/blog/how_to_build_candidate_sourcing_across_greenhouse_lever_workday_and_60_ats_platforms_with_a_unified_api
- Vercel sensitive environment variables — https://vercel.com/docs/environment-variables/sensitive-environment-variables
