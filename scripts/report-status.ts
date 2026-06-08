/**
 * scripts/report-status.ts
 *
 * Heartbeat reporter for the "jobs" agent (Jobs) in the CEO's Enterprise fleet.
 *
 * Run this at the END of each ceos-jobs agent run. It POSTs a status heartbeat
 * to the Fleet OS dashboard's /api/report endpoint, which calls
 * registry.upsertStatus() and writes the row into the Postgres agent_status
 * table (KV fallback key 'agent:status:jobs').
 *
 * The rich pipeline numbers ("N discovered · N submitted · ...") are computed
 * separately by lib/jobs.ts:getJobStats() over the shared 'job_applications'
 * table and merged into this agent's summary inside getFleet(). This script
 * only needs to push a liveness heartbeat: state, lastRun, a short summary,
 * and the ok flag. Keep the heartbeat lightweight; the dashboard owns the
 * aggregate view.
 *
 * Usage:
 *   tsx scripts/report-status.ts
 *   tsx scripts/report-status.ts ok "42 discovered · 9 submitted · 2 interviews"
 *   tsx scripts/report-status.ts warn "JSearch quota exhausted; ATS polling only"
 *   tsx scripts/report-status.ts error "Greenhouse poll failed: 5 boards timed out"
 *
 * Env:
 *   REPORT_SECRET (required) — shared secret sent as the 'x-report-secret' header.
 *   FLEET_URL     (optional) — base URL of the fleet dashboard.
 *                              Defaults to https://ceos-enterprise.vercel.app
 *
 * Requires Node 18+ for the global fetch API. No external dependencies.
 */

// Inline copy of the AgentStatus shape from ceos-enterprise/lib/types.ts.
// Keep this in sync with the dashboard's definition.
type AgentStatus = {
  state: 'ok' | 'warn' | 'error';
  lastRun: string; // ISO-8601, computed at runtime
  summary: string;
  ok: boolean;
};

const AGENT_ID = 'jobs';
const DEFAULT_FLEET_URL = 'https://ceos-enterprise.vercel.app';
const DEFAULT_SUMMARY = 'Jobs agent run complete — pipeline synced to fleet.';

/**
 * Push a single heartbeat to the fleet dashboard.
 * Resolves on a 2xx response; rejects (with context) otherwise.
 */
async function reportStatus(
  state: AgentStatus['state'] = 'ok',
  summary: string = DEFAULT_SUMMARY
): Promise<void> {
  const reportSecret = process.env.REPORT_SECRET;
  if (!reportSecret) {
    throw new Error(
      'REPORT_SECRET is not set. Add it to the ceos-jobs environment before reporting.'
    );
  }

  const fleetUrl = (process.env.FLEET_URL || DEFAULT_FLEET_URL).replace(/\/+$/, '');
  const endpoint = `${fleetUrl}/api/report`;

  const status: AgentStatus = {
    state,
    lastRun: new Date().toISOString(),
    summary,
    // 'ok' is true for healthy runs and degraded-but-running ('warn') states;
    // only a hard 'error' marks the agent as not ok.
    ok: state !== 'error',
  };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'x-report-secret': reportSecret,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ agentId: AGENT_ID, status }),
  });

  const text = await res.text().catch(() => '');

  if (!res.ok) {
    throw new Error(
      `Fleet report failed: ${res.status} ${res.statusText} -> ${endpoint}` +
        (text ? `\nResponse body: ${text}` : '')
    );
  }

  console.log(
    `[report-status] ${AGENT_ID} heartbeat accepted (${res.status}) ` +
      `state=${status.state} ok=${status.ok} lastRun=${status.lastRun}`
  );
  console.log(`[report-status] summary: ${status.summary}`);
}

/**
 * Parse simple positional CLI args: [state] [summary...]
 * - argv[0] (optional): one of 'ok' | 'warn' | 'error'. Defaults to 'ok'.
 * - argv[1..] (optional): the summary string (remaining args are joined with spaces).
 */
function parseArgs(argv: string[]): {
  state: AgentStatus['state'];
  summary: string;
} {
  let state: AgentStatus['state'] = 'ok';
  let rest = argv;

  if (argv.length > 0 && ['ok', 'warn', 'error'].includes(argv[0])) {
    state = argv[0] as AgentStatus['state'];
    rest = argv.slice(1);
  }

  const summary = rest.length > 0 ? rest.join(' ') : DEFAULT_SUMMARY;
  return { state, summary };
}

async function main(): Promise<void> {
  const { state, summary } = parseArgs(process.argv.slice(2));
  await reportStatus(state, summary);
}

main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[report-status] FAILED: ${message}`);
  process.exit(1);
});

export { reportStatus, type AgentStatus };
