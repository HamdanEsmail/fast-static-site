# fast-static-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/HamdanEsmail/fast-static-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/HamdanEsmail/fast-static-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A byte-exact, pure-JavaScript drop-in for makefun-site 1.0.0, written for CPU time: it reads the input as Latin-1 so every string stays one byte per char, renders Markdown and templates straight into JSON-escaped HTML in one output buffer (no `JSON.stringify` of the pages), and partially evaluates each site's templates so headers, navs, tag clouds and footers are rendered once per site.

How it works:

- **Byte mode.** `main.ts` reads `cases.json` as Latin-1, so each UTF-8 byte is one char, and writes the answer's bytes back unchanged. Only the Unicode rules need real characters (a slug's NFKD, a template's `\S`), and those decode on the spot. An input where bytes and characters could read differently (a `\u` escape, or Unicode whitespace) takes the exact UTF-16 path instead.
- **Answers written as JSON text.** Markdown and templates emit HTML already JSON-escaped into a preallocated buffer, page by page, so no page string outlives its page and nothing is stringified at the end.
- **Markdown in one pass.** Block rules are char-code tests instead of regular expressions; the inline renderer copies plain runs whole and escapes as it goes.
- **Templates compiled by partial evaluation.** Per site and per kind of page (page, index, tag, tags): everything that reads only `site`, `tags` and `recent` becomes constant text, loops over known arrays unroll, and what is left is a few closures over the page's own values.
- **V8 tuned for a short single-CPU run:** TurboFan off (its compiles never pay back in a run this short) and a larger young generation.

Every answer is checked against makefun-site 1.0.0 itself on the practice set and on freshly generated sites from the competition's own generator, in both modes.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e8x7n9mm&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
