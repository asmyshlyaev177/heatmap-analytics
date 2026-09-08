# Schema changes

`pnpm deploy` applies pending migrations before it deploys:

```jsonc
"deploy": "wrangler d1 migrations apply heatmap-analytics --remote && wrangler deploy"
```

That ordering is the whole point. A Worker deployed ahead of its migration 500s
every beacon on `no such column` until the migration lands — which is exactly
what happened when `003-country.sql` shipped, and `&&` is what stops it
happening again. Wrangler tracks what it has run in a `d1_migrations` table, so
a deploy with nothing pending prints "No migrations to apply" and moves on.
It also captures a backup first and rolls a failed migration back.

## Adding one

Both halves of a change land, and they are the same edit:

1. a numbered file here — `004-thing.sql`, sorting after the last one
2. the same statement in `schema.sql`, which is the shape of a *fresh* database

`schema.sql` is what `test/helpers/fake-d1.ts` builds the unit suite's database
from, so a column the code reads but `schema.sql` never creates fails
`pnpm test:unit` rather than reaching production.

Everything in `schema.sql` is `IF NOT EXISTS`: running it against an existing
database must be a no-op, never a silent rewrite of live data. That is also why
it cannot add a column, and why this folder exists.

## Bootstrapping a fresh database

```bash
pnpm db:schema        # schema.sql, then mark every migration applied
```

The second half matters. `schema.sql` already produces the current shape, so
every migration is satisfied the moment it exists — running `001` against it
would fail on a duplicate column. `wrangler d1 migrations apply` has no "mark
applied", so `scripts/db-baseline.mjs` writes the rows it would have written,
reading the names out of this directory rather than a list it could forget.

`pnpm db:baseline --remote` runs that half alone. It is idempotent
(`INSERT OR IGNORE`), and it is what was used once to adopt this scheme on a
database whose three migrations had already been applied by hand.

## The files

| | |
| --- | --- |
| `001-active-ms.sql` | engaged time, measured rather than inferred. |
| `002-replay-tickets.sql` | a whole table, so `IF NOT EXISTS`. Gentler about ordering than the others: ingest and every token-authenticated read work without it. What breaks is minting a replay link (a 500) and the tail of the nightly purge — the two retention deletes run first, so data still ages out, but the cron ends on an error. |
| `003-country.sql` | the visitor's country. |

Re-running `001` or `003` by hand errors on the duplicate column, which is the
intended signal that it already landed. `wrangler d1 migrations apply` never
re-runs one at all.
