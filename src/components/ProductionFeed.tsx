import { useEffect, useRef, useState } from 'react';

type FeedJob = {
  jobId: string;
  state: string;
  progress: { completed: number; shotCount: number };
  spentUsd: number;
  pendingSpendUsd: number;
  budget: { totalUsd: number; thresholdUsd?: number; crossed: boolean };
  review?: { findings: number; measured: number; visuallyFlagged: number; unverified: number };
  repairProposal?: { options: Array<{ id: string; costUsd: number }> };
  filmPath?: string;
  liveness: string;
  log: { present: boolean; behind: boolean; capped: boolean; tornLines: number };
};

type FeedEvent = {
  id: string;
  jobId: string;
  type: string;
  source: string;
  recordedAt?: number;
};

type FeedBody = {
  cursor?: string;
  jobs?: FeedJob[];
  events?: FeedEvent[];
  truncated?: boolean;
};

type Snapshot = { state: string; crossed: boolean };

function money(value: number): string {
  return `$${value.toFixed(2)}`;
}

function when(event: FeedEvent): string {
  if (typeof event.recordedAt !== 'number') return event.source;
  return new Date(event.recordedAt).toISOString();
}

function announce(previous: Map<string, Snapshot> | null, jobs: FeedJob[]): string[] {
  if (!previous) return [];
  const lines: string[] = [];
  for (const job of jobs) {
    const prior = previous.get(job.jobId);
    if (!prior && job.state === 'running') lines.push(`${job.jobId} started`);
    if (prior && prior.state !== job.state && (job.state === 'completed' || job.state === 'stopped' || job.state === 'failed')) {
      lines.push(`${job.jobId} ${job.state}`);
    }
    if (job.budget.crossed && !prior?.crossed) lines.push(`${job.jobId} budget crossed`);
  }
  return lines;
}

/**
 * Read-only section. It polls the loopback feed and never posts, never writes
 * sf_* keys, and never starts a render.
 */
export function ProductionFeed() {
  const [jobs, setJobs] = useState<FeedJob[] | null>(null);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [live, setLive] = useState('');
  const cursor = useRef<string | undefined>(undefined);
  const seen = useRef<Map<string, Snapshot> | null>(null);
  const eventIds = useRef(new Set<string>());

  useEffect(() => {
    let stopped = false;
    let timer = 0;
    let delay = 5_000;

    const schedule = (ms: number) => {
      if (stopped) return;
      timer = window.setTimeout(() => { void tick(); }, ms);
    };

    const apply = (body: FeedBody) => {
      const nextJobs = body.jobs ?? [];
      const lines = announce(seen.current, nextJobs);
      seen.current = new Map(nextJobs.map((job) => [job.jobId, { state: job.state, crossed: job.budget.crossed }]));
      if (lines.length > 0) setLive(lines.join('. '));
      setJobs(nextJobs);
      if (body.cursor) cursor.current = body.cursor;
      const fresh = (body.events ?? []).filter((event) => {
        if (eventIds.current.has(event.id)) return false;
        eventIds.current.add(event.id);
        return true;
      });
      if (fresh.length > 0) setEvents((current) => [...fresh, ...current].slice(0, 12));
      setUnavailable(false);
    };

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState !== 'visible') {
        schedule(delay);
        return;
      }
      try {
        const params = new URLSearchParams({ limit: '20' });
        if (cursor.current) params.set('cursor', cursor.current);
        const response = await fetch(`/api/production/feed?${params.toString()}`, {
          method: 'GET',
          cache: 'no-store',
          headers: { Accept: 'application/json' },
        });
        if (!response.ok) throw new Error('unavailable');
        const body = await response.json() as FeedBody;
        if (stopped) return;
        const previousCursor = cursor.current;
        apply(body);
        delay = 5_000;
        if (body.truncated && body.cursor && body.cursor !== previousCursor) {
          schedule(0);
          return;
        }
      } catch {
        if (stopped) return;
        setUnavailable(true);
        delay = Math.min(delay * 2, 60_000);
      }
      schedule(delay);
    };

    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      window.clearTimeout(timer);
      delay = 5_000;
      void tick();
    };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      stopped = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  return (
    <section
      className="min-w-0 rounded-2xl border border-zinc-800 bg-zinc-950 p-4 motion-reduce:transition-none"
      data-testid="production-feed"
      aria-labelledby="production-feed-heading"
    >
      <h3 id="production-feed-heading" className="text-sm font-medium text-zinc-100">MCP production</h3>
      <p className="mt-1 text-xs leading-relaxed text-zinc-300">
        Studio only reads this feed. It does not start, stop, approve, or repair a film.
        Use the MCP tools production_feed, check_sequence, review_continuity, and propose_repair.
      </p>
      <p className="mt-2 text-xs text-zinc-200" role="status" aria-live="polite">{live}</p>
      {unavailable && (
        <p className="mt-3 text-sm text-zinc-100" data-testid="production-feed-error">Production feed unavailable</p>
      )}
      {jobs && jobs.length === 0 && !unavailable && (
        <p className="mt-3 text-sm text-zinc-100">No MCP films yet.</p>
      )}
      {jobs && jobs.length > 0 && (
        <ul className="mt-3 space-y-3">
          {jobs.map((job) => (
            <li key={job.jobId} className="min-w-0 rounded-xl border border-zinc-800 p-3">
              <p className="break-all text-sm text-zinc-100">
                {job.jobId} · {job.state} · {job.liveness}
              </p>
              <p className="mt-1 text-xs text-zinc-300">
                {job.progress.completed}/{job.progress.shotCount} shots · spent {money(job.spentUsd)}
                {job.budget.thresholdUsd !== undefined ? ` of ${money(job.budget.thresholdUsd)}` : ''}
                {job.pendingSpendUsd > 0 ? ` · pending ${money(job.pendingSpendUsd)}` : ''}
              </p>
              {job.budget.crossed && (
                <p className="mt-1 text-xs font-medium text-amber-200">Budget crossed. This warning does not stop a render.</p>
              )}
              {job.review && (
                <p className="mt-1 text-xs text-zinc-300">
                  Review {job.review.findings} findings, {job.review.measured} measured, {job.review.visuallyFlagged} flagged, {job.review.unverified} unverified.
                </p>
              )}
              {job.repairProposal && job.repairProposal.options.length > 0 && (
                <p className="mt-1 break-words text-xs text-zinc-300">
                  Repair {job.repairProposal.options.map((option) => `${option.id} ${money(option.costUsd)}`).join(', ')}. Requires approval.
                </p>
              )}
              {job.filmPath && <p className="mt-1 break-all text-xs text-zinc-300">Film file {job.filmPath}</p>}
              {job.log.tornLines > 0 && <p className="mt-1 text-xs text-zinc-300">Event log skipped {job.log.tornLines} torn line{job.log.tornLines === 1 ? '' : 's'}.</p>}
              {!job.log.present && <p className="mt-1 text-xs text-zinc-300">Reconciled from the job file.</p>}
            </li>
          ))}
        </ul>
      )}
      {events.length > 0 && (
        <ul className="mt-3 space-y-1">
          {events.map((event) => (
            <li key={event.id} className="break-all text-[11px] text-zinc-300">
              {event.type} · {when(event)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
