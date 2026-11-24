# Semiscope public market ranks

The unified entry index ranks eligible US exchange listings using at least 252 trading sessions. The score combines pullback, stabilization, medium-term momentum and downside risk. Each compact row preserves the model inputs and component contributions. Legacy 252- and 504-session scores remain available for their original cohort.

The calculation matches the Nasdaq Trader directory date to completed, commit-pinned OHLCV data. If the directory advances before prices, the previous ranking keeps its trading date. Scores and ranks are adapted from [DoltHub stocks](https://www.dolthub.com/repositories/post-no-preference/stocks) and published under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

[Public ranking JSON](https://semiscope-ranks.deed.page/data/long-ranks.json)

The scheduled workflow checks at 07:17 and 15:41 UTC. Each successful publication records its date, digest, coverage, price revision and directory checksum in `last-run.json`. The matching listing directory is archived in `last-directory.json.gz`. Workflow dispatch with `verify_current` reproduces the current release from that directory and its historical price revision.

The workflow retains the eight most recent verified Nasdaq directory dates in `pending-directories/`. When price history arrives a day behind the newest directory, it can publish that completed price date using the matching archived listings. A missing matching directory leaves the previous publication in place.

The one-time `migrate_unified` release uses the original November 20, 2026 cohort. Review the local candidate with `node scripts/refresh-cloud-ranks.mjs --review-unified-candidate <file>`. Dispatch the migration with its reported `expected_content_sha256`. The cloud run independently reproduces the candidate, checks every legacy ranking field, verifies the new scores and publishes against the unchanged previous version. The publishing key is specific to the numerical data site.

The same schedule independently extends the [public daily price history](https://github.com/eric-choi-dev/semiscope-public-market-ranks/tree/history-deltas). It starts from the 4,389-symbol November 20, 2026 release and appends completed sessions from one pinned Dolt revision. Each update checks the preceding day, corporate actions and coverage, and records a content hash. A symbol whose price basis can no longer be verified is omitted from later daily updates. The data branch contains only CC BY-SA numerical files and attribution. Ranking publication and price-history publication can advance independently.
