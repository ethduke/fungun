import type { Destination } from './launch-model';

const FEE_INFO = {
  stonks: {
    label: 'Your fee share', creatorPercent: 70, remainder: '30% platform',
    details: 'The current standard split pays creators 70% of the 1% trading fee (0.7% of volume). The live share is shown on the card. The operator can change fee splits or reassign a creator after a 24-hour on-chain delay. Liquidity stays locked. The stock pairing is permanent; stale price feeds use the last saved anchor. Stock assets can restrict transfers. Launch details are recorded in an immutable event; the operator controls the hosted metadata URL. This route launches one billion tokens with no dev buy, and pays fees to your wallet. The contract has no launch deadline; cancel old wallet requests before retrying.',
    sourceLabel: 'Stonks launch and fee conditions', sourceUrl: 'https://www.thestonks.exchange/about',
  },
  stonx: {
    label: 'Your fee share', creatorPercent: 66.5, remainder: '28.5% stonx · 5% Doppler',
    details: 'After the first 10 seconds, trades pay a 1% hook fee plus a 0.05% LP fee. You receive 70% after Doppler’s 5% cut, equivalent to 66.5% of total fees. The hook fee starts at 80% and falls to 1% over 10 seconds. stonx controls fee routing and may change how much is distributed or reinvested.',
    sourceLabel: 'stonx fee documentation', sourceUrl: 'https://stonx.ai/docs/fees',
  },
  long: {
    label: 'Your LP fee share',
    creatorPercent: 95,
    remainder: '5% protocol',
    details:
      'The reviewed Robinhood RWA integration allocates 95% of LP fees to you and 5% to the protocol. Separate hook fees are not included. This is an integration setting, not a universal Long fee split; Doppler documents a configurable share of up to 95%.',
    sourceLabel: 'Doppler fee documentation',
    sourceUrl: 'https://docs.doppler.lol/how-it-works/fees-and-economics',
  },
  o1: {
    label: 'Your fee share',
    creatorPercent: 50,
    remainder: '50% platform / referrals',
    details:
      'On Base and Robinhood, you receive 50% of the normal 1% trading fee. With a valid referrer, the platform receives 30% and the referrer 20%; without one, the platform receives 50%. The extra anti-snipe fee during the first 20 seconds goes to the platform, not the creator.',
    sourceLabel: 'O1 fee documentation',
    sourceUrl: 'https://docs.o1.exchange/launchpad/trading/fees-referrals',
  },
  longbow: {
    label: 'Beneficiary hook fee share',
    creatorPercent: 65,
    remainder: '30% Longbow · 5% Doppler',
    details:
      'Fungun uses the independent Longbow launcher. The beneficiary receives 65% of hook fees; Longbow receives 30% and Doppler 5%. Separately, the beneficiary receives 95% of the 0.1% LP fee. Hook fees start at 80% and decay to 1% over 10 seconds. The full supply goes on the curve. The beneficiary can be your wallet or a compatible vault and claims fees in the currencies collected. No stock conversion or holder distribution is performed by Fungun. Doppler retains control over hook availability.',
    sourceLabel: 'Longbow independent launch route',
    sourceUrl: 'https://longbow.gg/launch?route=longbow',
  },
} as const;

export const FEE_INFO_REVIEWED = '2026-09-04';

export function launchpadFeeInfo(
  destination: Pick<Destination, 'id' | 'chainId' | 'route'>,
) {
  if (
    (destination.id === 'long' || destination.id === 'longbow') &&
    (destination.chainId !== 4663 || destination.route !== 'rwa')
  )
    return undefined;
  return destination.id === 'pons' ? undefined : FEE_INFO[destination.id];
}
