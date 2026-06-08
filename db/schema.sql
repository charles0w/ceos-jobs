-- =============================================================================
-- ceos-jobs — shared Postgres schema for the "Jobs" recruitment agent
-- =============================================================================
-- This is the SHARED schema between the ceos-jobs owner repo (the Jobs agent
-- that writes pipeline rows here) and ceos-enterprise / Fleet OS, whose
-- lib/jobs.ts runs getJobStats() — a single aggregate SQL over the
-- job_applications table below — to compute the agent's rich fleet summary
-- (mirroring lib/growth.ts -> getGrowthStats() over the 'businesses' table).
--
-- The Fleet dashboard reads job_applications.stage to render a summary like:
--   "<discovered> discovered · <submitted> submitted · <interview> interviews
--    · <offer> offers"
-- so the `stage` column is the load-bearing field — keep its enum values exactly
-- in sync with lib/jobs.ts and lib/types.ts.
--
-- Target: @vercel/postgres (Neon under the hood). Run via the `sql` tagged
-- template or psql. Idempotent — safe to run repeatedly (CREATE ... IF NOT
-- EXISTS everywhere). No extensions required beyond pgcrypto for gen_random_uuid().
--
-- Pipeline reference: GitHub community JSON feeds (SimplifyJobs/Summer2026-
-- Internships, vanshb03/New-Grad-2026) + public no-auth ATS endpoints
-- (Greenhouse, Lever, Ashby) feed job_listings; the human-in-the-loop
-- submission flow advances job_applications.stage. LinkedIn / Handshake are
-- never scraped (account-ban risk) — see ceos-jobs docs.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;  -- for gen_random_uuid()

-- -----------------------------------------------------------------------------
-- job_listings — every distinct posting the agent has discovered (the catalog).
-- One row per real-world posting; the dedup_key UNIQUE constraint absorbs the
-- same job surfaced by multiple sources (Simplify feed, direct Greenhouse poll,
-- JSearch, Adzuna). Normalize the key as lower(trim(company))|title|location.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_listings (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Provenance. `source` is the ingest channel: 'simplify', 'vanshb03',
  -- 'speedyapply', 'greenhouse', 'lever', 'ashby', 'workable', 'recruitee',
  -- 'jsearch', 'adzuna', 'manual'. `source_id` is that source's native id
  -- (Simplify listing id, Greenhouse job id, Lever posting id, etc.).
  source        TEXT NOT NULL,
  source_id     TEXT,

  -- Core posting fields (normalized out of `raw`).
  company       TEXT NOT NULL,
  title         TEXT NOT NULL,
  location      TEXT,
  remote        BOOLEAN NOT NULL DEFAULT FALSE,

  -- The direct ATS apply URL. Store the canonical form (strip tracking params
  -- with urllib.parse) so the same job from two sources collapses cleanly.
  url           TEXT,

  -- ATS platform behind `url`: 'greenhouse' | 'lever' | 'ashby' | 'workable'
  -- | 'recruitee' | 'workday' | 'icims' | 'taleo' | 'other'. Drives which
  -- submission tier the agent uses (direct API vs. assisted browser autofill).
  ats_type      TEXT,

  -- Terms / cycle, e.g. 'Summer 2026', 'New Grad 2026' (from the GitHub feeds).
  terms         TEXT,

  -- Whether the posting is still live. Set FALSE when it drops out of the feed;
  -- never DELETE — historical rows power application-timing analytics later.
  active        BOOLEAN NOT NULL DEFAULT TRUE,

  posted_at     TIMESTAMPTZ,           -- when the employer posted it
  discovered_at TIMESTAMPTZ NOT NULL DEFAULT now(),  -- when the agent first saw it

  -- Full original record from the source feed/API, kept verbatim for the LLM
  -- tailoring + interview-prep passes (postings disappear once a role closes).
  raw           JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Cross-source dedup key. Generated from normalized company|title|location;
  -- UNIQUE so a second source inserting the same job is rejected/ignored.
  dedup_key     TEXT NOT NULL UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_job_listings_company   ON job_listings (company);
CREATE INDEX IF NOT EXISTS idx_job_listings_source    ON job_listings (source);
CREATE INDEX IF NOT EXISTS idx_job_listings_active    ON job_listings (active);
CREATE INDEX IF NOT EXISTS idx_job_listings_posted_at ON job_listings (posted_at DESC);
-- One job per source should appear once per source; helps idempotent re-ingest.
CREATE UNIQUE INDEX IF NOT EXISTS uq_job_listings_source_pair
  ON job_listings (source, source_id) WHERE source_id IS NOT NULL;


-- -----------------------------------------------------------------------------
-- job_applications — the pipeline. One row per (listing the agent is pursuing).
-- THIS is the table ceos-enterprise/lib/jobs.ts aggregates for fleet stats.
-- The `stage` forward-only state machine: discovered -> queued -> tailoring ->
-- ready -> submitted -> assessment -> interview -> offer, with rejected /
-- ghosted as terminal exits at any point.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS job_applications (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- The posting being pursued. NULL allowed for one-off manual apps not in the
  -- catalog. ON DELETE SET NULL so deleting a listing never orphans pipeline.
  listing_id         UUID REFERENCES job_listings(id) ON DELETE SET NULL,

  -- Denormalized for the dashboard so getJobStats() needs no JOIN and rows
  -- survive a listing deletion.
  company            TEXT NOT NULL,
  title              TEXT NOT NULL,

  -- Load-bearing for fleet stats. Keep these values in lockstep with
  -- lib/jobs.ts and the STATUS MODEL in lib/types.ts.
  stage              TEXT NOT NULL DEFAULT 'discovered'
                     CHECK (stage IN (
                       'discovered',  -- ingested, not yet triaged
                       'queued',      -- scored relevant, awaiting tailoring
                       'tailoring',   -- resume / cover letter in progress
                       'ready',       -- tailored, awaiting human approval
                       'submitted',   -- application sent
                       'assessment',  -- OA / take-home assigned
                       'interview',   -- phone / technical / onsite stage
                       'offer',       -- offer extended
                       'rejected',    -- terminal: declined by employer
                       'ghosted'      -- terminal: no response past threshold
                     )),

  -- Artifacts produced by the tailoring pipeline (RenderCV/Typst PDF + cover
  -- letter), e.g. Vercel Blob URLs. Versioned naming: {company}_{role}_{date}.
  resume_variant_url TEXT,
  cover_letter_url   TEXT,

  -- Sourcing channel for per-source yield analytics, e.g. 'simplify',
  -- 'company_careers_page', 'referral', 'jsearch', 'adzuna'. Mirrors
  -- job_listings.source but captured at apply time (required for honest stats).
  source             TEXT,

  submitted_at       TIMESTAMPTZ,   -- when stage entered 'submitted'
  last_status_at     TIMESTAMPTZ NOT NULL DEFAULT now(),  -- last stage change

  notes              TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One active application per posting — guard against duplicate submissions.
  UNIQUE (listing_id)
);

CREATE INDEX IF NOT EXISTS idx_job_applications_stage      ON job_applications (stage);
CREATE INDEX IF NOT EXISTS idx_job_applications_company    ON job_applications (company);
CREATE INDEX IF NOT EXISTS idx_job_applications_source     ON job_applications (source);
CREATE INDEX IF NOT EXISTS idx_job_applications_submitted  ON job_applications (submitted_at DESC);
-- Fast queue polling for the worker (everything not yet terminal/submitted).
CREATE INDEX IF NOT EXISTS idx_job_applications_open_stage ON job_applications (stage)
  WHERE stage NOT IN ('submitted', 'offer', 'rejected', 'ghosted');


-- -----------------------------------------------------------------------------
-- answer_bank — flat key/value store of canned autofill answers + the single
-- canonical application profile. Every autofill layer (Greenhouse/Lever API
-- script, Simplify, a local Playwright filler) reads from this one source of
-- truth. Keys e.g. 'full_name', 'berkeley_email', 'phone', 'github_url',
-- 'gpa', 'grad_date', 'work_auth', 'sponsorship_required', 'eeo_gender',
-- 'eeo_race', 'eeo_veteran', 'answer:why_company', 'answer:technical_challenge'.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS answer_bank (
  key        TEXT PRIMARY KEY,
  value      TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);


-- -----------------------------------------------------------------------------
-- master_profile — structured experience bank that feeds the resume-tailoring
-- pipeline (the YAML/RenderCV master, mirrored into Postgres so the agent can
-- query it). One row per resume entry (work, project, education). `bullets`
-- holds the full bullet set; `tags` lists the skills each entry surfaces so the
-- tailoring step can tag-match against a JD's required_skills before any LLM
-- rewrite. This bank is read-only to the LLM — it is never modified by it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS master_profile (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- 'work' | 'project' | 'education' | 'skill_group'.
  entry_type  TEXT NOT NULL,

  organization TEXT,                 -- company / school / project name
  role         TEXT,                 -- title / degree
  start_date   TEXT,                 -- MM/YYYY (string for flexible formatting)
  end_date     TEXT,                 -- MM/YYYY or 'Present'

  -- Source facts for grounded tailoring. `bullets` = the raw achievement
  -- bullets; `context` = problem/scale/outcome the LLM may draw from but must
  -- not exceed; `tags` = skills for JD overlap matching.
  bullets     JSONB NOT NULL DEFAULT '[]'::jsonb,
  context     TEXT,
  tags        JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Display ordering on the rendered resume.
  sort_order  INTEGER NOT NULL DEFAULT 0,

  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_master_profile_type ON master_profile (entry_type);


-- -----------------------------------------------------------------------------
-- application_events — interview / OA / offer-call events tied to an
-- application, for Google Calendar sync (store the returned gcal_event_id so
-- events can be updated or cancelled) and reminder scheduling.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_events (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id UUID NOT NULL REFERENCES job_applications(id) ON DELETE CASCADE,

  -- 'oa' | 'phone_screen' | 'technical' | 'final' | 'offer_call' | 'deadline'.
  event_type     TEXT NOT NULL,

  scheduled_at   TIMESTAMPTZ,
  gcal_event_id  TEXT,               -- Google Calendar event id, if synced
  reminder_sent  BOOLEAN NOT NULL DEFAULT FALSE,

  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_events_app
  ON application_events (application_id);
CREATE INDEX IF NOT EXISTS idx_application_events_sched
  ON application_events (scheduled_at);


-- -----------------------------------------------------------------------------
-- application_emails — Gmail-ingested status signals (gmail.readonly scope).
-- The LLM classifier writes one row per relevant message; gmail_message_id is
-- UNIQUE so re-polling (Gmail History API) is idempotent. detected_status maps
-- to a stage transition on the linked application.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS application_emails (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  application_id   UUID REFERENCES job_applications(id) ON DELETE SET NULL,

  gmail_message_id TEXT NOT NULL UNIQUE,
  direction        TEXT NOT NULL DEFAULT 'inbound',  -- 'inbound' | 'outbound'

  -- Classifier output, e.g. 'applied_confirmed' | 'in_process' |
  -- 'oa_scheduled' | 'interview_scheduled' | 'rejected' | 'offer'.
  detected_status  TEXT,

  raw_snippet      TEXT,
  received_at      TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_application_emails_app
  ON application_emails (application_id);
