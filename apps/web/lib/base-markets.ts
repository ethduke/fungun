import type { CatalogPair } from './read-service';

// Labels for Base stocks verified against O1's active registry on 2026-09-07.
// Availability comes exclusively from the current per-platform catalog.
// Never use BaseStonk's catalog as evidence of O1 or Stonks launch support.
export const BASE_PAIRS: CatalogPair[] = [
  { id: 'rwa-603f4784b66148fa71835959', symbol: 'AAPL' },
  { id: 'rwa-a91ef7d25e9e3c9d201107e0', symbol: 'AMZN' },
  { id: 'rwa-7d8b3db85eead344a77a0ed2', symbol: 'GOOGL' },
  { id: 'rwa-e6c5bb4fa875bb0d70d5f96e', symbol: 'META' },
  { id: 'rwa-95b4b23c7b9f8237ec25af23', symbol: 'MSFT' },
  { id: 'rwa-bb07dfe00aa9483859be2df0', symbol: 'MSTR' },
  { id: 'rwa-0dbcf21ac01760ea26565809', symbol: 'NVDA' },
  { id: 'rwa-45459fed78ff9705109fe96f', symbol: 'SNDK' },
  { id: 'rwa-b79ceaee5a649b1ef29931b6', symbol: 'SPCX' },
  { id: 'rwa-bda7a8a51b8a3ff389c7efb2', symbol: 'TSLA' },
];
