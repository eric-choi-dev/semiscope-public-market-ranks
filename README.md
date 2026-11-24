# Semiscope public daily price history

This dated archive contains split-adjusted US regular-session daily open, high, low, close and volume for 4,389 securities with a verified Semiscope score on 2026-11-20. It contains 4,737,362 observed bars. Each security has its own coverage start. Trades, quotes, cash dividends and corporate accounting data are outside the archive.

The data and Semiscope's modifications are available under the [Creative Commons Attribution-ShareAlike 4.0 International license](https://creativecommons.org/licenses/by-sa/4.0/). The underlying database is [post-no-preference/stocks at the pinned Dolt revision](https://www.dolthub.com/repositories/post-no-preference/stocks/data/aef7n6a07m0r9tn7nrr0gfsjpstfdhr3). Semiscope used recorded splits to adjust historical OHLC prices and share volume, retained positive-volume observations, and truncated older records at unresolved corporate actions, invalid prices or extended trading gaps. The cutoff and reason for each such truncation are recorded in the manifest.

The manifest maps primary exchange symbols to parcel IDs, first and last covered trading days and bar counts. It records the SHA-256 digest of each parcel. Each bar is an array in the order `date, open, high, low, close, volume`. Dates refer to the US exchange session and amounts are in USD. These observed end-of-day prices are dated research data.

This branch preserves a dated baseline for chart lookups. The application pins an immutable Git revision. Verified newer daily records can be displayed separately by the public data service. Daily rank refreshes do not rewrite the archive.
