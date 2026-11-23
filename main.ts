// The harness runs `node /bot/main.ts` (node22): read every case from /input/cases.json, answer each with solve.js,
// write /output/answers.json (one answer per case, in order). MAKEFUN_INPUT_DIR and MAKEFUN_OUTPUT_DIR stand in for
// /input and /output outside a container.
import { readFileSync, writeFileSync } from 'node:fs';
import { setFlagsFromString } from 'node:v8';

// The house baseline's flag, and V8 tuned for a short, single-CPU run: no TurboFan (its compiles never pay back in a
// run this short), a larger young generation (fewer scavenges).
for (const flag of ['--no-incremental-marking', '--no-opt', '--min-semi-space-size=16', '--max-semi-space-size=64']) setFlagsFromString(flag);

const { answerAll } = await import('./solve.js');
const IN = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUT = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const buf = readFileSync(`${IN}/cases.json`);
const { data, encoding } = answerAll(buf.latin1Slice(0, buf.length));
writeFileSync(`${OUT}/answers.json`, data, encoding);
