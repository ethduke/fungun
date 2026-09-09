# Fee check results

Each completed source check has two outcomes:

- A verified positive balance that can be claimed: show its amounts and Claim fees.
- Verified balances with nothing claimable: show No fees to claim.

Results stay in the main list, including empty sources. The page no longer uses
Unavailable badges, More fees may be available, or a separate collapsed empty list.
Loading and failed checks are operation notices above the results, with retry for
failed checks. A missing provider/profile, an unverified amount, or a positive
balance blocked from claiming must never be converted into a zero-fee result.
Only eligible, live positions contribute to the displayed claim amounts.

Every source follows its continuation pages automatically under the user's fee
check intent. Concurrency stays at two sources, with repeated-cursor detection,
the existing 512-page cap, and cancellation on navigation/account changes.
Pagination failures retain any already-verified claimable positions. No background
polling or automatic wallet transaction is introduced.

`partial` without a continuation may describe supported contract coverage, such as
the current Pons escrow or configured Long pools, rather than unfinished balance
reads. Known zero balances in that supported scope produce the empty result.
The Coverage details disclosure retains the scope and exclusions.

## Required production configuration

Pons requires `PONS_FEE_PROFILE_JSON`. stonx requires `STONX_BASE_PROFILE_JSON`
and `STONX_FEE_MULTICALL_JSON`, in addition to the existing Base provider and gas
oracle pins. These fee profiles are independent of launch-enable flags. Keep the
reviewed values in runtime secrets; do not commit addresses/configuration captures
or copy an entire local environment into production.

The missing Pons/stonx rows were caused by those three absent runtime profiles.
Read-only cast checks verified the saved escrow and stonx code pins, plus the
existing Base gas-oracle proxy and implementation, before restoring the profiles.
Existing read/claim flags and launch settings remain unchanged.
