# Semiscope public market ranks

The long-term entry model produces separate 126-session and 252-session index scores for eligible US exchange listings. Each published row contains both index packets, a trading date and the ticker. Each horizon has its own 0–100 index, competition rank and count of issues at or above 80. Tied scores share a rank. An eligible issue without the required history has its exclusion recorded for both horizons.

Each index evaluates the price level, drawdown and evidence of support using the stock's own split-adjusted history. The model limits scores during a continuing decline. A score of 80 or more in the response phase qualifies as an entry signal. The packet includes the model version, and the snapshot includes the source digest and trading date. Reported scores use a 0–100 scale. Realized doubling rates are measured separately on later market prices.

The calculation matches the Nasdaq Trader directory date to completed, commit-pinned OHLCV data. If the directory advances before prices, the previous ranking keeps its trading date. Scores and ranks are adapted from [DoltHub stocks](https://www.dolthub.com/repositories/post-no-preference/stocks) and published under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/).

[Public ranking JSON](https://semiscope-ranks.deed.page/data/long-ranks.json)

The scheduled workflow checks at 07:17 and 15:41 UTC. Each successful publication records its date, digest, coverage, price revision and directory checksum in `last-run.json`. The matching listing directory is archived in `last-directory.json.gz`. Workflow dispatch with `verify_current` reproduces the current release from that directory and its historical price revision.

The workflow retains the eight most recent verified Nasdaq directory dates in `pending-directories/`. When price history arrives a day behind the newest directory, it can publish that completed price date using the matching archived listings. A missing matching directory leaves the previous publication in place.

The one-time `migrate_unified` update to `long-entry-index-4.0` uses the November 23, 2026 cohort and the exact version 7 release. `node scripts/refresh-cloud-ranks.mjs --check-packets-file <file>` validates both horizons, decoded packet contents, thresholds and tie ranks offline. Compare a candidate against the pinned public data and official exchange roster with `node scripts/refresh-cloud-ranks.mjs --review-unified-candidate <file>`. Dispatch the migration with its `expected_content_sha256`. A separate cloud rebuild must reproduce the reviewed content digest before it can publish against the verified prior release. The publishing key is specific to the numerical data site.

The same schedule independently extends the [public daily price history](https://github.com/eric-choi-dev/semiscope-public-market-ranks/tree/history-deltas). It starts from the 4,389-symbol November 20, 2026 release and appends completed sessions from one pinned Dolt revision. Each update checks the preceding day, corporate actions and coverage, and records a content hash. A symbol whose price basis can no longer be verified is omitted from later daily updates. The data branch contains only CC BY-SA numerical files and attribution. Ranking publication and price-history publication can advance independently.
