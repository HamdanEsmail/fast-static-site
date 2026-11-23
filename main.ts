// The harness runs `node /bot/main.ts` (node22): read every case from /input/cases.json, answer each with solve.js,
// write /output/answers.json (one answer per case, in order). MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output outside a container.
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// The house baseline's flag, and V8 kept to one thread for a short, one-CPU run: no optimizing compilers (their
// background compiles never pay back in a run this short) and a garbage collector that works on the main thread alone.
for (const flag of ['--no-incremental-marking', '--no-opt', '--no-maglev', '--single-threaded-gc', '--no-parallel-scavenge', '--no-concurrent-marking', '--no-parallel-marking', '--no-concurrent-sweeping', '--no-parallel-compaction', '--no-parallel-pointer-update', '--no-concurrent-array-buffer-sweeping']) setFlagsFromString(flag);

const { answerAll } = await import('./solve.js');
const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const buf = readFileSync(`${IN}/cases.json`);
const { data, encoding } = answerAll(buf.latin1Slice(0, buf.length));
writeFileSync(`${OUT}/answers.json`, data, encoding);
