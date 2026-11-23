// The harness runs `node /bot/main.ts` (node22): read every case from /input/cases.json, answer each with solve.js,
// write /output/answers.json (one answer per case, in order). MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output outside a container.
import { closeSync, openSync, readFileSync, writeSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// The house baseline's flag, and V8 kept to one thread for a short, one-CPU run: no optimizing compilers (their
// background compiles never pay back in a run this short) and young-generation collections on the main thread alone.
for (const flag of ['--no-incremental-marking', '--no-opt', '--no-maglev', '--no-parallel-scavenge']) setFlagsFromString(flag);

const { answerAll } = await import('./solve.js');
const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = `${process.env.MAKEFUN_OUTPUT_DIR ?? '/output'}/answers.json`;
let fd = openSync(OUT, 'w');
answerAll(
  readFileSync(`${IN}/cases.json`),
  (buffer, length) => writeSync(fd, buffer, 0, length),
  () => {
    closeSync(fd);
    fd = openSync(OUT, 'w');
  },
);
closeSync(fd);
