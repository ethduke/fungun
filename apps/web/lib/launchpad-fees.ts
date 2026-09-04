import type { Destination } from './launch-model';

const FEE_INFO = {
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
} as const;

export const FEE_INFO_REVIEWED = '2026-09-04';

export function launchpadFeeInfo(
  destination: Pick<Destination, 'id' | 'chainId' | 'route'>,
) {
  if (
    destination.id === 'long' &&
    (destination.chainId !== 4663 || destination.route !== 'rwa')
  )
    return undefined;
  return FEE_INFO[destination.id];
}
