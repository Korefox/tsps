// RSS hard guard for the test suite (see docs/agents/test-suite.md).
//
// package.json "test" runs:
//   node scripts/test-oom-guard.cjs --test --test-concurrency=1 --max-old-space-size=8192 "tests/**/*.test.cjs"
//
// --max-old-space-size only caps the V8 old-space heap. Native (out-of-heap)
// allocations — e.g. unbounded Buffer captures in a fixture — bypass it, so a
// single test worker can still grow without bound (measured: a quest fixture
// reached >45 GB RSS under the 8 GB heap cap). This wrapper spawns the usual
// `node --test` runner and polls the system every 2 s, terminating the largest
// test worker when any of these triggers fires so one runaway file can never
// take the whole machine down:
//
//   swap trigger  — swap usage grew more than 512 MB over the run baseline.
//                   This is the direct "about to overflow into swap" signal and
//                   fires first in practice: worker RSS growth stalls in the
//                   swap-thrashing zone, so an RSS cap alone is too late.
//   floor trigger — MemAvailable (free RAM, i.e. RAM usable without swapping)
//                   fell below the 250 MB reserve for the rest of the system.
//   budget trigger — a worker's RSS reached its budget: MemAvailable measured
//                   at startup minus the 250 MB reserve (floor 256 MB), so the
//                   guard adapts to the machine the suite runs on.
//
// The affected file is reported as a test failure by node --test, like any
// other failure.
//
// Overrides: OOM_GUARD_MB (static worker budget in MB) and OOM_GUARD_MEMINFO
// (meminfo file to read; for tests). On platforms without /proc (non-Linux)
// the wrapper is a transparent pass-through.

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');

const RESERVE_MB = 250; // floor: MemAvailable kept for the rest of the system
const FLOOR_MB = 256; // minimum worker budget
const SWAP_TRIGGER_MB = 512; // swap growth over baseline that means "spilling into swap"
const DEFAULT_CAP_MB = 8192; // fallback budget when MemAvailable is unreadable
const POLL_MS = 2000;
const KILL_GRACE_MS = 5000;

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('test-oom-guard: no node --test arguments given');
  process.exit(2);
}

const isLinux = process.platform === 'linux';

function meminfoKB(key) {
  try {
    const mi = fs.readFileSync(process.env.OOM_GUARD_MEMINFO || '/proc/meminfo', 'utf8');
    const m = mi.match(new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm'));
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

const STARTUP_AVAIL_KB = meminfoKB('MemAvailable');
const STARTUP_SWAP_KB = meminfoKB('SwapTotal') - meminfoKB('SwapFree');
const BUDGET_MB = process.env.OOM_GUARD_MB
  ? Number(process.env.OOM_GUARD_MB)
  : STARTUP_AVAIL_KB === 0
    ? DEFAULT_CAP_MB
    : Math.max(FLOOR_MB, Math.round(STARTUP_AVAIL_KB / 1024) - RESERVE_MB);

function rssKB(pid) {
  try {
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const m = status.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

function cmdline(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
  } catch {
    return [];
  }
}

function childrenOf(pid) {
  const out = [];
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      // Format: "pid (comm) state ppid ..." — comm may contain spaces, so
      // parse from the last ')'.
      const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
      if (ppid === pid) out.push(Number(entry));
    } catch {
      // Process exited between readdir and read; skip it.
    }
  }
  return out;
}

const runner = spawn(process.execPath, args, { stdio: 'inherit' });
const killed = new Map(); // pid -> { mb, kind }

function killWorker(pid, kb, kind, detail) {
  killed.set(pid, { mb: Math.round(kb / 1024), kind });
  const testFile = cmdline(pid).find((a) => a.includes('.test.')) ?? `pid ${pid}`;
  const mb = Math.round(kb / 1024);
  if (kind === 'swap') {
    console.error(
      `[oom-guard] swap usage grew ${detail} MB over the run baseline (spilling into swap); ` +
        `terminating largest worker ${testFile} (${mb} MB)`,
    );
  } else if (kind === 'floor') {
    console.error(
      `[oom-guard] MemAvailable fell to ${detail} MB (below the ${RESERVE_MB} MB floor); ` +
        `terminating largest worker ${testFile} (${mb} MB)`,
    );
  } else {
    console.error(
      `[oom-guard] ${testFile} reached ${mb} MB against the ${BUDGET_MB} MB budget; terminating worker`,
    );
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch {
    /* already gone */
  }
  setTimeout(() => {
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, KILL_GRACE_MS);
}

function sweep() {
  if (!isLinux || runner.pid == null) return;
  const rss = new Map();
  let biggest = null;
  for (const pid of childrenOf(runner.pid)) {
    if (killed.has(pid)) continue;
    const kb = rssKB(pid);
    rss.set(pid, kb);
    if (biggest == null || kb > biggest[1]) biggest = [pid, kb];
  }
  if (biggest == null) return;
  const [pid, kb] = biggest;
  // 1. The machine is spilling into swap (earliest reliable signal).
  const swapGrowthKB = meminfoKB('SwapTotal') - meminfoKB('SwapFree') - STARTUP_SWAP_KB;
  if (swapGrowthKB >= SWAP_TRIGGER_MB * 1024) {
    killWorker(pid, kb, 'swap', Math.round(swapGrowthKB / 1024));
    return;
  }
  // 2. Free RAM is down to the reserve floor.
  const availKB = meminfoKB('MemAvailable');
  if (availKB < RESERVE_MB * 1024) {
    killWorker(pid, kb, 'floor', Math.round(availKB / 1024));
    return;
  }
  // 3. A single worker consumed its full budget.
  if (kb / 1024 >= BUDGET_MB) {
    killWorker(pid, kb, 'budget');
  }
}

console.error(
  `[oom-guard] budget ${BUDGET_MB} MB (MemAvailable at start ${Math.round(STARTUP_AVAIL_KB / 1024)} MB - ${RESERVE_MB} MB); ` +
    `swap baseline ${Math.round(STARTUP_SWAP_KB / 1024)} MB; triggers: swap +${SWAP_TRIGGER_MB} MB, MemAvailable < ${RESERVE_MB} MB, worker >= budget`,
);
const timer = setInterval(sweep, POLL_MS);

runner.on('close', (code) => {
  clearInterval(timer);
  if (killed.size > 0) {
    const detail = [...killed.entries()]
      .map(([pid, v]) => `worker ${pid}=${v.mb}MB (${v.kind})`)
      .join(', ');
    console.error(`[oom-guard] terminated ${killed.size} over-limit worker(s): ${detail}`);
  }
  process.exit(code ?? 1);
});

runner.on('error', (err) => {
  clearInterval(timer);
  console.error(`test-oom-guard: ${err.message}`);
  process.exit(1);
});
