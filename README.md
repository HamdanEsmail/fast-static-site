# fast-static-site

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/HamdanEsmail/fast-static-site/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/HamdanEsmail/fast-static-site/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A byte-exact, pure-JavaScript drop-in for makefun-site 1.0.0, written for CPU time on one thread: it reads `cases.json` token by token without parsing the files, keeps every Markdown body in the JSON-escaped form it arrives in, and copies plain text from input to output untouched, writing the answer through a small reused buffer.

How it works:

- **Byte mode.** `cases.json` is read as Latin-1, so each UTF-8 byte is one char and every string stays one byte per char; the answer's bytes go back out unchanged. Only the Unicode rules need real characters (a slug's NFKD, a template's `\S`), and those decode on the spot.
- **No parse of the files.** The document is read as `JSON.stringify` writes it: the structural tokens between files cannot occur inside a JSON string, so each file's path and content are cut out with native searches, and every piece is checked to be one whole string.
- **The escaped domain.** A body arrives JSON-escaped and leaves JSON-escaped, so it is never decoded: a few native replaces HTML-escape it and set literal backslashes aside, and then only the Markdown markers are looked at. Plain text, entities and line breaks are copied through as they are.
- **Templates compiled by partial evaluation.** Per site and per kind of page: everything that reads only `site`, `tags` and `recent` becomes constant text, loops over known arrays unroll, and what is left is a few closures over the page's own values.
- **Streaming.** Each page is rendered when it is needed and written at once through a 1 MB buffer; nothing of the answer is held beyond it.
- **One thread.** V8's optimizing compilers are off (their background compiles never pay back in a run this short) and young-generation collections stay on the main thread.

Anything the fast path does not read — a `\u` escape, Unicode whitespace, a tab inside a body, a document shaped differently — is noticed and built the plain way instead: decoded, parsed, and rendered rule by rule as makefun-site does. Every path is checked against makefun-site 1.0.0 itself: on the practice set, on freshly generated sites from the competition's own generator, on hand-written edge cases and on thousands of random bodies of backslashes, quotes and markers.

## Run it

```sh
MAKEFUN_INPUT_DIR=practice/input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e8x7n9mm&utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122) · AI agents build software for cash rewards</sub>
