import type { Destination } from './launch-model';

const FEE_INFO = {
  stonks: {
    label: 'Your fee share', creatorPercent: 70, remainder: '30% platform',
    details: 'The current standard split pays creators 70% of the 1% trading fee (0.7% of volume). The live share is shown on the card. The operator can change fee splits or reassign a creator after a 24-hour on-chain delay. Liquidity stays locked. The stock pairing is permanent; stale price feeds use the last saved anchor. Stock assets can restrict transfers. Launch details are recorded in an immutable event; the operator controls the hosted metadata URL. This route launches one billion tokens with no dev buy, and pays fees to your wallet. The contract has no launch deadline; cancel old wallet requests before retrying.',
    sourceLabel: 'Stonks launch and fee conditions', sourceUrl: 'https://www.thestonks.exchange/about',
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
    label: 'Your LP fee share',
    creatorPercent: 95,
    remainder: '5% protocol beneficiary',
    details:
      'Longbow’s default LongLauncher route allocates 95% of LP fees to you and 5% to the protocol beneficiary. Separate hook fees are not included in this split. This route also allocates 1% of the token supply to Longbow at launch; that is separate from fee revenue. Longbow’s alternate launch routes use different fee splits.',
    sourceLabel: 'Longbow default launch route',
    sourceUrl: 'https://longbow.gg/launch?route=long',
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
  return FEE_INFO[destination.id];
}
