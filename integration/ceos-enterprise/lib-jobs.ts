// Copy to ceos-enterprise/lib/jobs.ts. Then in lib/registry.ts getFleet():
// import { getJobStats }, fetch it alongside growthStats, and override
// statuses['jobs'] with a summary like:
// `${j.total} found, ${j.tailored} tailored, ${j.submitted} submitted, ${j.interviews} interviews, ${j.offers} offers`.
import { sql } from '@vercel/postgres';

export interface JobStats {
  total: number;
  tailored: number;
  submitted: number;
  interviews: number;
  offers: number;
  lastActivity: string | null;
}

export async function getJobStats(): Promise<JobStats | null> {
  try {
    const { rows } = await sql`
      SELECT
        COUNT(*)                                                          AS total,
        COUNT(*) FILTER (WHERE status NOT IN ('discovered', 'queued'))    AS tailored,
        COUNT(*) FILTER (WHERE submitted_at IS NOT NULL)                  AS submitted,
        COUNT(*) FILTER (WHERE status IN ('interviewing', 'offer'))       AS interviews,
        COUNT(*) FILTER (WHERE status = 'offer')                          AS offers,
        MAX(status_updated_at)                                            AS last_activity
      FROM job_applications
    `;
    const r = rows[0];
    return {
      total: Number(r.total),
      tailored: Number(r.tailored),
      submitted: Number(r.submitted),
      interviews: Number(r.interviews),
      offers: Number(r.offers),
      lastActivity: r.last_activity ?? null,
    };
  } catch {
    return null;
  }
}
