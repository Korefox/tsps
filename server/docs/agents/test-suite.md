# Running the test suite and its memory budget

Run the full suite from `server/`:

```bash
yarn test
```

The script is:

```
node --test --test-concurrency=1 --max-old-space-size=8192 "tests/**/*.test.cjs"
```

## Memory budget

Test runs must not exceed 10 GB of system RAM. `yarn test` enforces that with two
guards:

- `--test-concurrency=1` — runs test files serially, one worker at a time.
- `--max-old-space-size=8192` — caps the old-space heap at 8 GB. Node passes it
  through to the `--test` child processes, so every test file runs under the cap.

Some fixtures retain objects for the lifetime of the file (see below). With the
default parallel runner every worker accumulates its own copy, and the suite can
need far more than the budget. Serial plus the 8 GB cap keeps the heaviest file
(about 5.8 GB heap peak) comfortably under it.

If a single file still dies with `FATAL ERROR: Reached heap limit` under the cap,
that file is retaining more than 8 GB on its own — fix the fixture, do not raise
the cap.

## Why some fixtures retain memory

`node:test`'s `t.mock.method()` records every call to the mocked function. Node 24's
mock wrapper (`lib/internal/test_runner/mock/mock.js`) pushes, for each call:

```js
{ arguments, error, result, stack: new Error(), target, this }  // -> ctx.#calls
```

So every call to a mocked function costs one record object plus one `new Error()`
capturing the full call stack at that moment. If a fixture mocks a hot function —
`Date.now` (called all over the game: per-tick packet encoding, perf timers,
keepalives) or `Math.random` (combat and loot rolls) — a single file accumulates
millions of recorded calls. Each record's `stack` Error also pins the objects that
were on the stack when it was captured, including live player objects.

Example: `tests/clan-wars-game.test.cjs` — `mGame()` runs
`t.mock.method(Date, 'now', ...)` in every magic test. One mid-run heap snapshot
(3.41 GB heap used, clock 370219) showed:

- 2,250,870 `Error` objects — one per recorded mock call;
- 516 live `MockFunctionContext` objects; the largest held **2,114,131 recorded
  calls** (the `Date.now` mock, called from every tick of every actor);
- 2,647,627 `Buffer` objects (about 262 MB) — the fixture's unbounded
  `p.nativePackets.push(Buffer.from(frame))` capture;
- 1,406 live `Player` objects, each still holding its full companion subsystem
  (`PacketSender`, `MovementQueue`, `ClientConnection`, ...), pinned by the
  captured call stacks.

The file's heap grows monotonically and never drops (about 1 GB at 174k ticks,
2.6 GB at 300k, 4.3 GB at 407k; ~99.7% of the heap still live when it dies):

| Run | Result |
| --- | --- |
| `node --test --max-old-space-size=4096 tests/clan-wars-game.test.cjs` | `FATAL ERROR: Reached heap limit` at ~97% of the file — the file alone exhausts 4 GB |
| same, `--max-old-space-size=8192` | completes, ~5.8 GB heap peak |
| upstream's own single-file run | all 1,553 cases pass, 7.53 GiB peak |

## Verifying a genuine leak in a test case

When a test file uses too much memory, establish that it is genuine retention
(objects kept alive), not GC lag or parallelism:

1. **Single file, capped, serial** — the file must leak on its own:

   ```bash
   cd server && node --test --max-old-space-size=4096 tests/<file>.test.cjs
   ```

   If it dies with `FATAL ERROR: Reached heap limit` before the last test, one
   file alone is retaining memory. Parallelism cannot be the cause.

2. **Confirm retention with the GC log** — after-GC heap keeps climbing and stays
   up instead of dropping:

   ```bash
   node --trace-gc --test --max-old-space-size=4096 tests/<file>.test.cjs 2>&1 \
     | grep -E "Heap after" | tail -40
   ```

3. **Snapshot the live heap** — take one while the file is still running:

   ```bash
   cd server && node --heapsnapshot-signal=SIGUSR2 --test tests/<file>.test.cjs &
   kill -USR2 <pid>   # once the heap has grown (watch the --trace-gc output)
   ```

   Node writes `Heap.<timestamp>.<pid>....heapsnapshot` in the working directory.
   Open it in Chrome DevTools (Memory tab):

   - class histogram: count `MockFunctionContext` (one per still-retained mock) and
     `Error` (one per recorded mock call);
   - the largest `MockFunctionContext`'s `#calls` array length is the recorded-call
     count; each entry's `stack` Error shows what the capture pinned;
   - unbounded fixture arrays (like a `nativePackets` Buffer list) show up as large
     `Buffer` counts.

4. **Minimal repro, no game required** — shows the mock recording itself grows:

   ```js
   // /tmp/mock-recording.test.cjs
   const { test } = require('node:test');
   test('mock records every call', async t => {
     const h = process.memoryUsage().heapUsed;
     const mock = t.mock.method(Date, 'now', () => 12345);
     for (let i = 0; i < 100000; i++) Date.now();
     console.log('callCount:', mock.mock.callCount());
     console.log('heap growth MB:', ((process.memoryUsage().heapUsed - h) / 1048576).toFixed(2));
   });
   ```

   → `callCount: 100000`, ~87 MB of heap growth: one record plus one `new Error()`
   plus its stack capture, per call.

## Fixture hygiene

- Do not `t.mock.method()` a hot per-tick function (`Date.now`, `Math.random`) for
  the whole file unless the number of ticks is bounded. Restore or reset between
  subtests (`mock.mock.resetCalls()`, `t.mock.restore()`).
- Bound capture arrays (cap or periodically clear a `nativePackets`-style list).
- A fixture that runs millions of ticks should log actors out between subtests so
  their companion subsystems can be released.
