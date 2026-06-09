/**
 * lib-jobs.ts — DROP-IN for ceos-enterprise/lib/jobs.ts
 *
 * This is the canonical copy of the Jobs stats module that lives at
 * `ceos-enterprise/lib/jobs.ts`. Copy it there verbatim. It reads the
 * `job_applications` table (owned by ceos-jobs, see ceos-jobs/db/schema.sql)
 * and rolls it up into a small JobStats summary the enterprise dashboard
 * renders for the `jobs` agent.
 *
 * Schema notes (job_applications — authoritative shape):
 *   - The lifecycle column is `stage` (NOT `status`), constrained to:
 *     'discovered','queued','tailoring','ready','submitted',
 *     'assessment','interview','offer','rejected','ghosted'.
 *   - "Tailored" is derived from `resume_variant_url IS NOT NULL`
 *     (a real tailored artifact exists); there is NO `tailored_at` column.
 *   - "Submitted" is derived from `submitted_at IS NOT NULL`.
 *   - "Interviews" counts the interview-ish stages 'assessment' and 'interview'.
 *   - Last activity is `MAX(last_status_at)` (the column is `last_status_at`,
 *     NOT `status_updated_at`).
 *
 * ── Wiring into lib/registry.ts getFleet() ───────────────────────────────
 * Import getJobStats and fetch it alongside getGrowthStats in the same
 * Promise.all, then override the `jobs` status (guarded on discovered > 0):
 *
 *   import { getJobStats } from './jobs';
 *
 *   const [statuses, growthStats, jobStats] = await Promise.all([
 *     getAllStatuses(),
 *     getGrowthStats(),
 *     getJobStats(),
 *   ]);
 *
 *   if (jobStats && jobStats.discovered > 0) {
 *     const summary = `${jobStats.discovered} found · ${jobStats.tailored} tailored · ${jobStats.submitted} applied · ${jobStats.interviews} interviews · ${jobStats.offers} offers`;
 *     statuses['jobs'] = {
 *       state: 'ok',
 *       lastRun: jobStats.lastActivityAt ?? new Date().toISOString(),
 *       summary,
 *       ok: true,
 *     };
 *   }
 *
 * The `new Date().toISOString()` fallback matches the existing growth block
 * in lib/registry.ts. The `jobs` agent is registered in lib/agents.ts as:
 *   { id: 'jobs', name: 'Jobs',
 *     role: 'Internship/job scraping, tailoring, submission tracking',
 *     ownerRepo: 'ceos-jobs',
 *     skills: ['scraping','resume-tailoring','submission','tracking'],
 *     schedule: 'daily ingest + on-demand tailoring' }
 * ─────────────────────────────────────────────────────────────────────────
 */

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
        COUNT(*)                                                      AS discovered,
        COUNT(*) FILTER (WHERE resume_variant_url IS NOT NULL)        AS tailored,
        COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)              AS submitted,
        COUNT(*) FILTER (WHERE stage IN ('assessment', 'interview'))  AS interviews,
        COUNT(*) FILTER (WHERE stage = 'offer')                       AS offers,
        MAX(last_status_at)                                           AS last_activity_at
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
