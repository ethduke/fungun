# O1 RWA and ETH pairings

Verified 2026-09-04T16:24:15.503Z: **194 RWA choices + native ETH = 195 requested pairing choices** on Robinhood Chain (4663). These are launch quote choices (your new token paired with the selected asset), not existing RWA/ETH trading pools.

The configured read service returned all 194 registered, selectable RWA quotes from creation-enabled suites in one block-tagged O1 configuration response. The endpoint is not paginated. IDs and symbols were validated before saving the complete dropdown snapshot in apps/web/lib/o1-markets.ts. No credentials or operational addresses are stored in that file.

The webview loads current availability once on entry and checks again when an expired pairing menu is opened. Fresh results replace the saved list, including a valid empty catalog. If availability cannot be checked, the menu keeps the dated saved catalog for browsing; O1 RWA draft validation still requires an unexpired live catalog. There is no refresh button or background retry loop.

## Full requested list

**ETH** uses the standard/native route. The following 194 symbols use the RWA route:

| Initial | Symbols |
| --- | --- |
| A | AAOI, AAPL, ABCL, ADBE, AEHR, AEIS, ALAB, AMAT, AMBA, AMC, AMD, AMKR, AMZN, ANET, APLD, APP, ASML, ASTS, AUR, AVAV, AVGO, AXON, AXTI |
| B | BA, BABA, BB, BE, BND, BULL |
| C | CBRS, CCL, CEG, CELH, CIEN, CLOV, CLS, CLSK, COHR, COIN, COST, CRCL, CRDO, CRM, CRWD, CRWV, CSCO, CTSH, CVNA |
| D | DDOG, DELL, DJT, DOCN |
| E | ELF, EWT, EWY |
| F | F, FICO, FIG, FISV, FIX, FLNC, FLY, FTNT, FUTU |
| G | GE, GEV, GLD, GLW, GLXY, GME, GOOGL |
| H | HII, HIMS, HPE, HWM |
| I | IBM, IBRX, INDA, INFQ, INOD, INTC, INTU, IONQ, IREN |
| J | JBL, JNJ, JOBY |
| K | KLAC, KSS, KTOS |
| L | LHX, LITE, LLY, LMT, LRCX, LULU, LUNR |
| M | MDB, META, MOD, MPWR, MRNA, MRVL, MSFT, MSTR, MTSI, MU, MXL |
| N | NAVN, NBIS, NET, NFLX, NNE, NOW, NU, NVDA, NVTS |
| O | OKLO, ON, ONTO, ORCL, OUST |
| P | P, PANW, PATH, PENG, PFE, PL, PLTR, POET, POWL, PR, PWR |
| Q | QBTS, QCOM, QQQ, QUBT |
| R | RBLX, RCAT, RDDT, RDW, RGTI, RIVN, RKLB, RUN |
| S | SATS, SCHD, SGOV, SHOP, SHY, SIMO, SKHY, SLS, SLV, SMCI, SMH, SMR, SNAP, SNDK, SNOW, SOFI, SOUN, SOXX, SPCX, SPMO, SPY |
| T | TE, TEAM, TEM, TER, TSEM, TSLA, TSM, TTD, TTWO |
| U | UMC, UNH, UPS, USAR, USO |
| V | VICR, VRT, VSAT, VST, VTI |
| W | WDAY, WDC, WULF, WYFI |
| X | XLK, XNDU, XOM |
| Z | ZM, ZS |

## Coverage and sources

- [O1 configuration API](https://docs.o1.exchange/launchpad/public-api/reference/meta/get-api-configuration): request chain_id=4663, market=rwa, include=chains,suites,quotes, active_only=true. The live response, rather than another launchpad's list or generated ticker guesses, supplied this snapshot.
- [Official Robinhood stock registry](https://docs.o1.exchange/launchpad/reference/robinhood-stock-quotes.json): independently cross-checked all 194 symbols and address-derived IDs against the live response; no differences.
- [O1 production registry](https://docs.o1.exchange/launchpad/reference/production-deployments.json) and [token creation](https://docs.o1.exchange/launchpad/create/token-creation): ETH is the native standard-route choice. O1 additionally documents USDG as a separate standard-route quote; it is outside the requested RWA + ETH list and is not represented by the current native-only standard launch model.
- Base remains paused in this webview. Its assets must not be combined with Robinhood's catalog.
- Long and Longbow retain their independently sourced catalogs; a token supported by O1 does not establish support on another venue.

Availability can change after this snapshot. Listing a quote does not establish liquidity, launch execution readiness, or availability on another chain.
