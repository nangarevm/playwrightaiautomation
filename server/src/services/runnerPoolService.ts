// FR-4.3/FR-4.5/FR-4.17: a real (if single-process, local) runner pool.
//
// Previously `queueExecution` inserted a `queued` row and nothing ever picked
// it up again -- there was no processor at all, so queued runs sat forever and
// `queue_position` was a number set once at insert time that never changed as
// jobs ahead of it completed. This service is the actual FIFO processor:
//   - FR-4.5: ticks on an interval, dequeues the oldest eligible queued run(s)
//     when capacity is free, and recomputes every remaining queued row's
//     `queue_position` after each tick so it reflects "jobs ahead of it".
//   - FR-4.3: the shared pool's size (`sharedPoolSize`) scales up when the
//     shared queue backlog exceeds current capacity, and scales down when the
//     queue drains -- a real (bounded, local) capacity adjustment driven by
//     queued job volume, not a static number.
//   - FR-4.17: an Execution Profile with `reserved_runner_count > 0` gets that
//     many dedicated slots that are never counted against/contended by the
//     shared pool -- a reserved job always has capacity even when the shared
//     pool is fully saturated by other orgs'/teams' runs.

import { db } from "../db.js";
import { runExecution } from "./executionService.js";
import { logAudit } from "./adminService.js";

// Keep pool at 5 workers for now (override via RUNNER_POOL_MIN / RUNNER_POOL_MAX).
const MIN_SHARED_POOL_SIZE = Number(process.env.RUNNER_POOL_MIN) || 5;
const MAX_SHARED_POOL_SIZE = Number(process.env.RUNNER_POOL_MAX) || 5;

let sharedPoolSize = MIN_SHARED_POOL_SIZE;
const activeShared = new Set<string>(); // run ids currently executing against the shared pool
const activeReserved = new Map<string, Set<string>>(); // profileId -> set of run ids using its reserved lane

export function getPoolStatus() {
  return {
    sharedPoolSize,
    sharedActive: activeShared.size,
    sharedAvailable: Math.max(0, sharedPoolSize - activeShared.size),
    reservedLanes: Array.from(activeReserved.entries()).map(([profileId, runs]) => ({ profileId, active: runs.size })),
    minPoolSize: MIN_SHARED_POOL_SIZE,
    maxPoolSize: MAX_SHARED_POOL_SIZE,
  };
}

function recomputeQueuePositions() {
  const queued = db.prepare("SELECT id FROM execution_runs WHERE status = 'queued' ORDER BY created_at ASC").all() as Array<{ id: string }>;
  const update = db.prepare("UPDATE execution_runs SET queue_position = ? WHERE id = ?");
  queued.forEach((row, i) => update.run(i + 1, row.id));
}

// FR-4.3: scale the shared pool based on queued backlog (jobs not covered by a
// reservation). Logged as an audit entry so scaling events are observable,
// mirroring how FR-9.4 failover events are logged.
function autoscale(sharedQueuedCount: number) {
  const before = sharedPoolSize;
  if (sharedQueuedCount > sharedPoolSize && sharedPoolSize < MAX_SHARED_POOL_SIZE) {
    // Jump toward demand quickly (was +1/tick, which stayed tiny for large batches).
    const target = Math.min(MAX_SHARED_POOL_SIZE, Math.max(sharedQueuedCount, MIN_SHARED_POOL_SIZE));
    sharedPoolSize = Math.min(MAX_SHARED_POOL_SIZE, Math.max(sharedPoolSize + 2, target));
  } else if (sharedQueuedCount === 0 && activeShared.size === 0 && sharedPoolSize > MIN_SHARED_POOL_SIZE) {
    sharedPoolSize = Math.max(MIN_SHARED_POOL_SIZE, sharedPoolSize - 1);
  }
  if (sharedPoolSize !== before) {
    logAudit(undefined, "runner_pool_autoscaled", "runner_pool", null, { from: before, to: sharedPoolSize, sharedQueuedCount });
  }
}

function defaultTargetUrl() {
  return `http://localhost:${process.env.PORT || 4100}/demo/login.html`;
}

// FR-4.5: the actual queue processor. Call on an interval (index.ts) and also
// immediately after every `queueExecution` call so a queued run doesn't wait a
// full tick if capacity is already free.
export async function processExecutionQueue(): Promise<{ started: number }> {
  const queued = db.prepare("SELECT * FROM execution_runs WHERE status = 'queued' ORDER BY created_at ASC").all() as any[];
  if (queued.length === 0) return { started: 0 };

  const sharedQueued = queued.filter((r) => !r.reserved_runner_count);
  autoscale(sharedQueued.length);

  let started = 0;
  for (const run of queued) {
    const reserved = Number(run.reserved_runner_count || 0);
    if (reserved > 0 && run.profile_id) {
      const lane = activeReserved.get(run.profile_id) ?? new Set<string>();
      if (lane.size >= reserved) continue; // reserved lane full -- wait for a slot in it specifically
      lane.add(run.id);
      activeReserved.set(run.profile_id, lane);
      started++;
      runExecution(run.script_id, defaultTargetUrl(), { profile_id: run.profile_id }, run.id).finally(() => {
        lane.delete(run.id);
      });
      continue;
    }

    if (activeShared.size >= sharedPoolSize) continue; // shared pool saturated this tick
    activeShared.add(run.id);
    started++;
    runExecution(run.script_id, defaultTargetUrl(), { profile_id: run.profile_id }, run.id).finally(() => {
      activeShared.delete(run.id);
    });
  }

  recomputeQueuePositions();
  return { started };
}
