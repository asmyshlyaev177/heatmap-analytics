# Schema changes

`schema.sql` is the shape of a *fresh* database. Every statement in it is
`IF NOT EXISTS`, so running it against an existing one is a no-op that cannot add
a column — the point being that it must be safe to re-run and must never silently
rewrite live data.

An existing database is brought up to that shape by a numbered file here, applied
once, by hand:

```bash
pnpm db:migrate --file=migrations/001-active-ms.sql
pnpm db:migrate --file=migrations/002-replay-tickets.sql
pnpm db:migrate --file=migrations/003-country.sql
```

Both halves of a change land: the migration for databases that exist, the same
statement in `schema.sql` for ones that do not.

**Apply the migration before deploying a Worker that writes the new column**, or
every beacon 500s on `no such column` until it lands. This is the same ordering
the `salts` removal needed, in reverse.

## The files

| | |
| --- | --- |
| `001-active-ms.sql` | engaged time, measured rather than inferred. Re-running errors on the duplicate column — the intended signal that it already landed. |
| `002-replay-tickets.sql` | a whole table, so `IF NOT EXISTS` and safe to re-run. Gentler about ordering: ingest and every token-authenticated read work without it. What breaks is minting a replay link (a 500) and the tail of the nightly purge — the two retention deletes run first, so data still ages out, but the cron ends on an error. Apply it first anyway. |
| `003-country.sql` | the visitor's country. Errors on the duplicate column, same as 001. |
