import {
  createWalletClient,
  custom,
  recoverTypedDataAddress,
  type EIP1193Provider,
} from 'viem';
import {
  ImageGenerationError,
  imageAuthorizationTypes,
  validateImageQuoteInput,
  type ImageQuote,
  type ImageOperation,
  type ImageProof,
} from './image-generation.ts';

let signing = false;
export async function signImagePayment(
  provider: EIP1193Provider,
  quote: ImageQuote,
  input: ImageOperation,
  isCurrent: () => boolean,
): Promise<ImageProof> {
  if (signing) throw new ImageGenerationError('image_busy');
  signing = true;
  try {
    await validateImageQuoteInput(quote, input, location.origin);
    const terms = quote.accepts[0];
    const identity = async () => {
      const accounts = await provider.request({ method: 'eth_accounts' });
      const chain = await provider.request({ method: 'eth_chainId' });
      if (
        !isCurrent() ||
        accounts[0]?.toLowerCase() !== input.wallet ||
        BigInt(chain) !== 4663n
      )
        throw new ImageGenerationError('image_context_changed');
      if (terms.extra.expiresAt - Date.now() < 240000)
        throw new ImageGenerationError('image_quote_expired');
    };
    await identity();
    const authorization = {
      from: input.wallet as `0x${string}`,
      to: terms.payTo,
      value: terms.amount,
      validAfter: String(Math.floor(terms.extra.issuedAt / 1000) - 60),
      validBefore: String(Math.floor(terms.extra.expiresAt / 1000)),
      nonce: terms.extra.nonce,
    };
    const payload = {
      domain: {
        name: terms.extra.name,
        version: terms.extra.version,
        chainId: 4663,
        verifyingContract: terms.asset,
      },
      types: imageAuthorizationTypes,
      primaryType: 'TransferWithAuthorization' as const,
      message: {
        ...authorization,
        value: BigInt(authorization.value),
        validAfter: BigInt(authorization.validAfter),
        validBefore: BigInt(authorization.validBefore),
      },
    };
    const signature = await createWalletClient({
      transport: custom(provider, { retryCount: 0 }),
    }).signTypedData({ account: authorization.from, ...payload });
    await identity();
    if (
      (
        await recoverTypedDataAddress({ ...payload, signature })
      ).toLowerCase() !== input.wallet
    )
      throw new ImageGenerationError('invalid_image_payment');
    if (!isCurrent()) throw new ImageGenerationError('image_context_changed');
    return {
      x402Version: 2,
      resource: quote.resource,
      accepted: terms,
      payload: { signature, authorization },
    };
  } catch (error) {
    let cause = error;
    for (let i = 0; i < 8 && cause && typeof cause === 'object'; i++) {
      if (
        ('code' in cause && cause.code === 4001) ||
        ('name' in cause && cause.name === 'UserRejectedRequestError')
      )
        throw new ImageGenerationError('image_rejected');
      cause = 'cause' in cause ? cause.cause : null;
    }
    throw error instanceof ImageGenerationError
      ? error
      : new ImageGenerationError('invalid_image_payment');
  } finally {
    signing = false;
  }
}
