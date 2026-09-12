# Independent Longbow launches

Fungun prepares new Longbow launches through Longbow's own wrapper and the current
Rehype hook. It does not inherit the LONG launcher, pause state, ticker registry,
allocation recipient or enable flag. Existing LONG launches and legacy Longbow
receipt recovery retain their original encoding and saved profiles.

## Launch behavior

- The full billion-token supply goes on the curve; no platform token allocation.
- Token addresses end in `1337`. LONG retains `1e18` addresses.
- The optional fee beneficiary defaults to the connected wallet. A different
  wallet or compatible vault can receive both fee streams. Zero, burn, protocol
  and integrator beneficiaries are rejected.
- Of gross hook fees, the beneficiary receives 65%, Longbow 30% and Doppler 5%.
  Separately, the beneficiary receives 95% of the pool's 0.1% LP fee.
- Hook fees start at 80% and fall to 1% over ten seconds. Fee routing uses the
  beneficiary pot, no buyback or LP-reinvestment legs, and the burn address as
  routing controller. The integrator starts with no currency conversion.
- Fees accrue in the currencies collected. This change does not implement stock
  conversion, holder snapshots, drops or a reward vault. Contract beneficiaries
  must implement calls to the hook's `collectFees(address)` and the initializer's
  `collectFees(bytes32)` themselves. The existing Fungun LP-fee dashboard is not a
  combined dashboard for the new hook fees; Longbow's coin page has its own tools.

The beneficiary is saved with the draft, included in recovery scope and launch
identity, encoded identically by server and browser, and displayed in the review.
The wallet checks runtime hashes and simulates immediately before submission.
Confirmation requires a matching Longbow event, full Airlock supply, initializer
state, and the beneficiary's LP and hook shares. LONG ticker reservations no longer
block Longbow or force the user to deselect LONG.

## Runtime configuration

Set these API-only variables independently:

- `LONGBOW_WALLET_LAUNCH=true`
- `LONGBOW_LAUNCH_PROFILE_JSON`: the standard dependency/hash profile with
  `launchpad: "longbow"` and `route: "independent"`; omit `platformAllocation`.
- `LONGBOW_LAUNCH_GUARDS_JSON`: token beacon and implementation pins for the stock
  quote templates. Shares the existing stock catalog and asset service.
- `LONGBOW_EXTRA_QUOTES_JSON`: optional explicit market quote definitions and
  implementation/oracle guards, using the existing extra-quote schema. No fallback
  to `LONG_EXTRA_QUOTES_JSON`.

Keep deployment addresses and hashes in the private runtime configuration. Missing
Longbow enablement disables new Longbow requests; an enabled malformed or legacy
profile fails closed. Preserve the running Machine configuration, volume, secrets
and other launch routes when releasing the images and these Longbow settings.

## Verification and limits

On 2026-09-12, read-only Foundry checks at block 61,241,544 matched all seven
configured dependency runtime hashes, the wrapper's Airlock, protocol owner,
module states and enabled hook flags. The new encoder successfully simulated an
independent creation with a beneficiary different from the sender. No transaction
was broadcast. A saved existing launch event matched the Longbow ABI, and both fee
shares were checked at current state. The public RPC did not retain that launch's
historical state; this was not a historical transaction replay.

These are runtime pins, simulations and state checks, not a full source audit of
the new wrapper/hook. Doppler governance can still change hook availability, and
beneficiaries can transfer their own rights. A chosen contract beneficiary must be
reviewed independently; entering its address alone does not establish a usable or
immutable rewards vault.

Public references: [Longbow independent launch](https://longbow.gg/launch?route=longbow),
[Doppler fees](https://docs.doppler.lol/how-it-works/fees-and-economics),
[Robinhood network details](https://docs.robinhood.com/chain/connecting/).
