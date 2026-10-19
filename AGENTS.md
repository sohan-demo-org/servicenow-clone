# Agent notes

- Commands: `npm test` (node:test API tests on an in-memory seeded DB), `npm run typecheck`, `npm run lint` (existing React warnings in other files are known), `npm run dev` (API :3001, Vite :5173).
- Virtual Agent (`server/va.ts`), from PR #2 review:
  - Pre-filter search candidates in SQL (`searchRows`) instead of a `listRecords` page, otherwise records past the page limit are never ranked.
  - Keep order-intent regexes narrow: bare "need a" also matches troubleshooting ("need a fix"). Soft phrasing goes to the catalog only when no trouble words are present.
  - `rank` needs a score of 2, but falls back to the single best body-only literal match so the user isn't told nothing matched.
  - Truncate only `short_description` (160 chars); store the user's full text in `description`.
