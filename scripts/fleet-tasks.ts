/**
 * scripts/fleet-tasks.ts
 *
 * Service the CEO's delegation queue for the "jobs" agent.
 *
 * The CEO (ceos-enterprise /ceo) delegates work into a queue; this client
 * closes the loop — the agent working in this repo (a Claude session, or
 * Charles) picks tasks up and reports their fate, which the dashboard's
 * Delegations panel reflects live.
 *
 * At the START of a working session:
 *   tsx scripts/fleet-tasks.ts list          # anything queued for jobs?
 *   tsx scripts/fleet-tasks.ts start <id>    # claim it (shows in progress)
 *   ... do the work ...
 *   tsx scripts/fleet-tasks.ts done <id>     # close it
 *   tsx scripts/fleet-tasks.ts drop <id>     # won't do (obsolete)
 *
 * Env:
 *   REPORT_SECRET (required) — same shared secret as report-status.ts.
 *   FLEET_URL     (optional) — defaults to https://ceos-enterprise.vercel.app
 *
 * Requires Node 18+ for global fetch. No external dependencies.
 * Canonical Python twin: ceos-enterprise/reporter/fleet_tasks.py
 */

const AGENT_ID = 'jobs';
const DEFAULT_FLEET_URL = 'https://ceos-enterprise.vercel.app';
const STATUSES = ['queued', 'in_progress', 'done', 'dropped'] as const;

type TaskStatus = (typeof STATUSES)[number];

type FleetTask = {
  id: number;
  agentId: string;
  title: string;
  spec: string;
  status: TaskStatus;
  createdBy: string;
  createdAt: string;
};

function config(): { base: string; secret: string } {
  const secret = process.env.REPORT_SECRET;
  if (!secret) {
    throw new Error('REPORT_SECRET is not set. Add it to the ceos-jobs environment.');
  }
  const base = (process.env.FLEET_URL || DEFAULT_FLEET_URL).replace(/\/+$/, '');
  return { base, secret };
}

async function fetchTasks(status?: TaskStatus): Promise<FleetTask[]> {
  const { base, secret } = config();
  const q = new URLSearchParams({ agentId: AGENT_ID });
  if (status) q.set('status', status);
  const res = await fetch(`${base}/api/tasks?${q}`, {
    headers: { 'x-report-secret': secret },
  });
  if (!res.ok) throw new Error(`GET /api/tasks failed: ${res.status} ${res.statusText}`);
  const data = (await res.json()) as { tasks: FleetTask[] };
  return data.tasks ?? [];
}

async function updateTask(id: number, status: TaskStatus): Promise<boolean> {
  const { base, secret } = config();
  const res = await fetch(`${base}/api/tasks`, {
    method: 'PATCH',
    headers: { 'x-report-secret': secret, 'content-type': 'application/json' },
    body: JSON.stringify({ id, status }),
  });
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`PATCH /api/tasks failed: ${res.status} ${res.statusText}`);
  return true;
}

function age(iso: string): string {
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (!Number.isFinite(mins)) return '?';
  if (mins < 60) return `${mins}m`;
  if (mins < 60 * 24) return `${Math.floor(mins / 60)}h`;
  return `${Math.floor(mins / (60 * 24))}d`;
}

async function main(): Promise<void> {
  const [cmd = 'list', idArg] = process.argv.slice(2);

  if (cmd === 'list') {
    const open = [
      ...(await fetchTasks('queued')),
      ...(await fetchTasks('in_progress')),
    ];
    if (open.length === 0) {
      console.log(`no open tasks for '${AGENT_ID}' — the CEO's queue is clear`);
      return;
    }
    for (const t of open) {
      console.log(`#${String(t.id).padEnd(4)} [${t.status.padEnd(11)}] ${age(t.createdAt).padStart(3)} ago  ${t.title}`);
      console.log(`      ${t.spec.slice(0, 160)}`);
    }
    return;
  }

  const statusFor: Record<string, TaskStatus> = { start: 'in_progress', done: 'done', drop: 'dropped' };
  const status = statusFor[cmd];
  if (status && idArg) {
    const id = Number(idArg);
    const ok = await updateTask(id, status);
    console.log(ok ? `task #${id} → ${status}` : `task #${id} not found`);
    if (!ok) process.exit(1);
    return;
  }

  console.error('usage: tsx scripts/fleet-tasks.ts [list | start <id> | done <id> | drop <id>]');
  process.exit(2);
}

main().catch((err: unknown) => {
  console.error(`[fleet-tasks] FAILED: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

export { fetchTasks, updateTask, type FleetTask, type TaskStatus };
