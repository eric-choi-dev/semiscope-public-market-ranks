# Semiscope daily EOD updates

This separate data branch contains verified US regular-session updates for the licensed historical archive published at 2fd62a22f088acdf6d6a1e1b66d43f533230d3c0. Daily packets are preserved in days/ and grouped by month and primary exchange symbol into shards/. The index points at immutable Git commits and SHA-256 checksums. A missing trade, changed issuer, uncertain corporate action or unverifiable price continuity leaves the historical series at its last verified session.

Source and license: [post-no-preference/stocks](https://www.dolthub.com/repositories/post-no-preference/stocks) under [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). Daily OHLCV fields share a confirmed split-adjusted holding basis. Cash dividends are excluded.
