# ceos-jobs → ceos-enterprise Integration

This document is the exact, copy-pasteable contract for plugging the **Jobs** agent (this repo, `ceos-jobs`) into the CEO's Enterprise fleet dashboard (`ceos-enterprise`, deployed at `ceos-enterprise.vercel.app`). It was written against the live `ceos-enterprise` source — `lib/agents.ts`, `lib/growth.ts`, `lib/registry.ts`, `lib/types.ts`, and `app/api/report/route.ts` — and the code blocks below match those files' types and `@vercel/postgres` `sql` tagged-template usage verbatim. Apply them as-is.

## How the fleet contract works

The dashboard is a thin Next.js 15.5 (App Router) app. Every agent in the fleet shows up because of three things, and the Jobs agent needs all three:

1. **Registry entry.** `lib/agents.ts` exports `AGENTS: Agent[]`. The dashboard only knows an agent exists if it has a row here. The slots `hobbies` and `school` are marked "(new — Phase 4)" — Jobs is a new entry alongside them, not a replacement for either.

2. **Status heartbeat.** Owner repos push a status object after each run by POSTing to `https://ceos-enterprise.vercel.app/api/report`. That route calls `registry.upsertStatus()`, which writes the `agent_status` table (`id` PK, `state`, `last_run`, `summary`, `ok`, `updated_at`) with a Vercel KV fallback at key `agent:status:<id>`. `getFleet()` reads that table and hands each agent its `AgentStatus | null`. This is the minimum to make the Jobs tile go green.

3. **Rich stats via a shared table.** The Growth agent does more than push a string — it owns a shared Postgres table (`businesses`), exposes `getGrowthStats()` (one aggregate SQL query), and `registry.getFleet()` *overrides* the `growth` status with a computed summary like `"<n> scraped · <n> sites built · <n> emails sent · <n> replies · <n> closed"`. Jobs mirrors this exactly: it writes its pipeline rows into a shared `job_applications` table, exposes `getJobStats()`, and `getFleet()` merges a computed summary for `agentId` `'jobs'`. The heartbeat keeps the tile alive even when the table is empty; the rich-stats merge takes over once rows exist.

The division of labor: the heavy lifting — daily ingest from the SimplifyJobs/vanshb03 GitHub JSON feeds and the Greenhouse/Lever/Ashby public ATS endpoints, LLM resume tailoring, human-in-the-loop submission tracking — all lives here in `ceos-jobs`. `ceos-enterprise` only renders the result. Jobs reports up; the dashboard never reaches down into this repo.

---

## STEP 1 — Register the agent

Add this object to the `AGENTS` array in **`ceos-enterprise/lib/agents.ts`** (e.g. right after the `growth` entry, since the two share the rich-stats pattern):

```ts
{
  id: 'jobs',
  name: 'Jobs',
  role: 'Internship/job scraping, tailoring, submission tracking',
  ownerRepo: 'ceos-jobs',
  skills: ['scraping', 'resume-tailoring', 'submission', 'tracking'],
  schedule: 'daily ingest + on-demand tailoring',
},
```

The `id` must be exactly `'jobs'` — it is the key used by both the heartbeat (`agent_status.id`) and the rich-stats override in `getFleet()`. `ownerRepo` is `'ceos-jobs'`, matching this repository.

---

## STEP 2 — Rich stats over the shared table

Create **`ceos-enterprise/lib/jobs.ts`**, mirroring `lib/growth.ts` exactly in style — a typed interface, one aggregate `sql` query over the shared `job_applications` table, `Number(...)` coercion on every count, and a `try/catch` that returns `null` so a missing table never breaks the fleet view.

The `job_applications` schema follows the pipeline state machine from the research (Discovered → … → Submitted → Interviewing → Offer). The aggregate surfaces the funnel counts that matter on a dashboard tile: total discovered, tailored, submitted, interviews, offers, and last activity.

```ts
import { sql } from '@vercel/postgres';

export interface JobStats {
  discovered: number;
  tailored: number;
  submitted: number;
  interviews: number;
  offers: number;
  lastActivityAt: string | null;
}

export async function getJobStats(): Promise<JobStats | null> {
  try {
    const { rows } = await sql`
      SELECT
        COUNT(*)                                                          AS discovered,
        COUNT(*) FILTER (WHERE tailored_at IS NOT NULL)                   AS tailored,
        COUNT(*) FILTER (WHERE status IN ('submitted', 'oa', 'interviewing', 'offer', 'closed')) AS submitted,
        COUNT(*) FILTER (WHERE status IN ('oa', 'interviewing'))          AS interviews,
        COUNT(*) FILTER (WHERE status = 'offer')                          AS offers,
        MAX(status_updated_at)                                            AS last_activity_at
      FROM job_applications
    `;
    const r = rows[0];
    return {
      discovered: Number(r.discovered),
      tailored: Number(r.tailored),
      submitted: Number(r.submitted),
      interviews: Number(r.interviews),
      offers: Number(r.offers),
      lastActivityAt: r.last_activity_at ?? null,
    };
  } catch {
    return null;
  }
}
```

Notes on the schema this query assumes (owned and migrated by `ceos-jobs`, see STEP 4):

- `status` is the forward-only state machine: `discovered | queued | tailoring | ready | submitted | oa | interviewing | offer | closed`. `submitted` is counted as "any application that reached or passed the submit gate," which is why it includes the later states — the funnel never decreases as a row advances.
- `interviews` counts rows currently in an assessment/interview state (`oa`, `interviewing`); `offers` counts terminal `offer`.
- `tailored_at` is a nullable timestamp set when the LLM tailoring pass + human diff approval completes (the Tailoring→Ready gate).
- `status_updated_at` is bumped on every state transition and powers `lastActivityAt`, the analogue of Growth's `lastScrapedAt`.

---

## STEP 3 — Merge into the fleet

Patch **`ceos-enterprise/lib/registry.ts`**. Add the import alongside the existing `getGrowthStats` import:

```ts
import { getGrowthStats } from './growth';
import { getJobStats } from './jobs';
```

Then extend `getFleet()` to fetch and merge the Jobs stats. Replace the existing `getFleet()` body's data-fetch and growth-merge with this (the growth block is unchanged; the jobs block is added below it):

```ts
export async function getFleet(): Promise<AgentWithStatus[]> {
  const [statuses, growthStats, jobStats] = await Promise.all([
    getAllStatuses(),
    getGrowthStats(),
    getJobStats(),
  ]);

  if (growthStats && growthStats.total > 0) {
    const summary = `${growthStats.total} scraped · ${growthStats.sitesBuilt} sites built · ${growthStats.outreachSent} emails sent · ${growthStats.outreachReplied} replies · ${growthStats.closed} closed`;
    statuses['growth'] = {
      state: 'ok',
      lastRun: growthStats.lastScrapedAt ?? new Date().toISOString(),
      summary,
      ok: true,
    };
  }

  if (jobStats && jobStats.discovered > 0) {
    const summary = `${jobStats.discovered} found · ${jobStats.tailored} tailored · ${jobStats.submitted} applied · ${jobStats.interviews} interviews · ${jobStats.offers} offers`;
    statuses['jobs'] = {
      state: 'ok',
      lastRun: jobStats.lastActivityAt ?? new Date().toISOString(),
      summary,
      ok: true,
    };
  }

  return AGENTS.map((agent) => ({
    agent,
    status: statuses[agent.id] ?? null,
  }));
}
```

This is a one-to-one mirror of the growth block: same `&& .discovered > 0` guard so an empty/missing table falls back to the plain heartbeat from STEP 4, same `lastRun` fallback to `new Date().toISOString()`, same `state: 'ok'`, `ok: true` shape required by `AgentStatus` in `lib/types.ts`.

---

## STEP 4 — Reporting and shared-table writes from ceos-jobs

This repo does two things to `ceos-enterprise`'s Postgres, both after each ingest/tailoring/submission run:

**(a) Push a status heartbeat.** A small script — `scripts/report-status.ts` in this repo — POSTs to `/api/report` exactly as the contract specifies. This is what keeps the tile alive even before any `job_applications` rows exist (e.g. a run that scraped feeds but hit an error mid-tailoring would report `state: 'warn'`).

```ts
// ceos-jobs/scripts/report-status.ts
import type { AgentStatus } from '../lib/types'; // local copy of the shared AgentStatus shape

const ENDPOINT = 'https://ceos-enterprise.vercel.app/api/report';

export async function reportStatus(status: AgentStatus): Promise<void> {
  const res = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'x-report-secret': process.env.REPORT_SECRET!,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agentId: 'jobs', status }),
  });
  if (!res.ok) {
    throw new Error(`report failed: ${res.status} ${await res.text()}`);
  }
}

// Example call at the end of a daily ingest run:
await reportStatus({
  state: 'ok',
  lastRun: new Date().toISOString(),
  summary: 'daily ingest complete',
  ok: true,
});
```

The `agentId` is `'jobs'` and the `status` body must match the `AgentStatus` interface (`state: 'ok' | 'warn' | 'error'`, ISO `lastRun`, `summary`, `ok`). `/api/report` validates the `x-report-secret` header against `REPORT_SECRET` and calls `registry.upsertStatus('jobs', status)`, which writes `agent_status` (KV fallback `agent:status:jobs`).

**(b) Write pipeline rows into the shared `job_applications` table.** Because Jobs uses the rich-stats pattern, it owns this table and writes directly to the same Postgres database `ceos-enterprise` reads from. Connect with the same `@vercel/postgres` `sql` helper using the `POSTGRES_URL` env (Vercel auto-injects `POSTGRES_URL` for the linked Neon database; use the pooled connection string). Create the table once on startup, mirroring how `registry.ts` does `CREATE TABLE IF NOT EXISTS`:

```ts
// ceos-jobs — run once at startup / in a migration
import { sql } from '@vercel/postgres';

export async function ensureJobTable(): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS job_applications (
      id                 TEXT PRIMARY KEY,
      company            TEXT NOT NULL,
      title              TEXT NOT NULL,
      location           TEXT,
      source             TEXT,                 -- simplify | vanshb03 | greenhouse | lever | ashby | jsearch | adzuna
      ats_type           TEXT,                 -- greenhouse | lever | ashby | workday | other
      apply_url          TEXT,
      status             TEXT NOT NULL DEFAULT 'discovered',
      resume_version     TEXT,
      tailored_at        TIMESTAMPTZ,
      status_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
}
```

Upsert a row whenever a listing is discovered or advances a stage. Use the normalized canonical-apply-URL hash as `id` so the same posting from two sources (e.g. a SimplifyJobs feed row and a direct Greenhouse poll) dedupes to one row:

```ts
await sql`
  INSERT INTO job_applications (id, company, title, location, source, ats_type, apply_url, status, status_updated_at)
  VALUES (${id}, ${company}, ${title}, ${location}, ${source}, ${atsType}, ${applyUrl}, ${status}, now())
  ON CONFLICT (id) DO UPDATE SET
    status = EXCLUDED.status,
    status_updated_at = now()
`;
```

When a tailoring pass is approved, set `tailored_at` and bump `status`:

```ts
await sql`
  UPDATE job_applications
  SET tailored_at = now(), resume_version = ${resumeVersion}, status = 'ready', status_updated_at = now()
  WHERE id = ${id}
`;
```

### Required environment

Both this repo's status script and its DB writer need:

| Env var | Used by | Notes |
| --- | --- | --- |
| `REPORT_SECRET` | `scripts/report-status.ts` | Must match `ceos-enterprise`'s `REPORT_SECRET`; sent as the `x-report-secret` header. |
| `POSTGRES_URL` | the `sql` shared-table writes | Same Neon database `ceos-enterprise` reads from; use the pooled (`?pgbouncer=true`) connection string. Vercel auto-injects this on a linked project. |

Store both as Vercel **sensitive** environment variables (and as GitHub repository secrets if the daily ingest runs in GitHub Actions). Never commit them; keep a `.env.example` with the keys and no values. Do not put resume/cover-letter PII in KV/Upstash — keep it in Postgres with restricted access.

---

## Rendering

Nothing else is needed on the dashboard side. Once STEP 1 registers `id: 'jobs'`, `GET /api/agents` → `getFleet()` returns the Jobs `AgentWithStatus`, and `components/Fleet.tsx` (via `components/CeoOS.tsx`) renders the tile automatically — heartbeat summary first, then the rich `"… found · … tailored · … applied · … interviews · … offers"` line as soon as `job_applications` has rows.
