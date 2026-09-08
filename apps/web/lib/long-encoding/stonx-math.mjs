// Adapted from @whetstone-research/doppler-sdk 1.0.40 (MIT), Whetstone Research.
// Copyright (c) Whetstone Research. Permission is hereby granted, free of charge,
// to any person obtaining a copy of this software and associated documentation
// files (the "Software"), to deal in the Software without restriction, including
// without limitation the rights to use, copy, modify, merge, publish, distribute,
// sublicense, and/or sell copies of the Software, and to permit persons to whom
// the Software is furnished to do so, subject to the following conditions:
// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software. THE SOFTWARE IS PROVIDED "AS
// IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT
// LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE
// AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE
// LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF
// CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
// SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
const MIN_TICK = -887272, MAX_TICK = 887272;
const MAX_UINT128 = (1n << 128n) - 1n, Q96 = 1n << 96n;
function getSqrtRatioAtTick(tick) {
  if (tick < MIN_TICK || tick > MAX_TICK) {
    throw new Error("Tick out of bounds");
  }
  const absTick = tick < 0 ? -tick : tick;
  let ratio = (absTick & 1) !== 0 ? 0xfffcb933bd6fad37aa2d162d1a594001n : 0x100000000000000000000000000000000n;
  if ((absTick & 2) !== 0)
    ratio = ratio * 0xfff97272373d413259a46990580e213an >> 128n;
  if ((absTick & 4) !== 0)
    ratio = ratio * 0xfff2e50f5f656932ef12357cf3c7fdccn >> 128n;
  if ((absTick & 8) !== 0)
    ratio = ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0n >> 128n;
  if ((absTick & 16) !== 0)
    ratio = ratio * 0xffcb9843d60f6159c9db58835c926644n >> 128n;
  if ((absTick & 32) !== 0)
    ratio = ratio * 0xff973b41fa98c081472e6896dfb254c0n >> 128n;
  if ((absTick & 64) !== 0)
    ratio = ratio * 0xff2ea16466c96a3843ec78b326b52861n >> 128n;
  if ((absTick & 128) !== 0)
    ratio = ratio * 0xfe5dee046a99a2a811c461f1969c3053n >> 128n;
  if ((absTick & 256) !== 0)
    ratio = ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4n >> 128n;
  if ((absTick & 512) !== 0)
    ratio = ratio * 0xf987a7253ac413176f2b074cf7815e54n >> 128n;
  if ((absTick & 1024) !== 0)
    ratio = ratio * 0xf3392b0822b70005940c7a398e4b70f3n >> 128n;
  if ((absTick & 2048) !== 0)
    ratio = ratio * 0xe7159475a2c29b7443b29c7fa6e889d9n >> 128n;
  if ((absTick & 4096) !== 0)
    ratio = ratio * 0xd097f3bdfd2022b8845ad8f792aa5825n >> 128n;
  if ((absTick & 8192) !== 0)
    ratio = ratio * 0xa9f746462d870fdf8a65dc1f90e061e5n >> 128n;
  if ((absTick & 16384) !== 0)
    ratio = ratio * 0x70d869a156d2a1b890bb3df62baf32f7n >> 128n;
  if ((absTick & 32768) !== 0)
    ratio = ratio * 0x31be135f97d08fd981231505542fcfa6n >> 128n;
  if ((absTick & 65536) !== 0)
    ratio = ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9n >> 128n;
  if ((absTick & 131072) !== 0)
    ratio = ratio * 0x5d6af8dedb81196699c329225ee604n >> 128n;
  if ((absTick & 262144) !== 0)
    ratio = ratio * 0x2216e584f5fa1ea926041bedfe98n >> 128n;
  if ((absTick & 524288) !== 0)
    ratio = ratio * 0x48a170391f7dc42444e8fa2n >> 128n;
  if (tick > 0) ratio = (2n ** 256n - 1n) / ratio;
  return ratio >> 32n;
}
function getLiquidityForAmount0(sqrtRatioAX96, sqrtRatioBX96, amount0) {
  let [lower, upper] = [sqrtRatioAX96, sqrtRatioBX96];
  if (lower > upper) [lower, upper] = [upper, lower];
  const diff = upper - lower;
  if (diff === 0n) return 0n;
  if (lower <= 0n) {
    throw new Error("sqrtRatio must be positive");
  }
  return amount0 * lower * upper / (Q96 * diff);
}
function getLiquidityForAmount1(sqrtRatioAX96, sqrtRatioBX96, amount1) {
  let [lower, upper] = [sqrtRatioAX96, sqrtRatioBX96];
  if (lower > upper) [lower, upper] = [upper, lower];
  const diff = upper - lower;
  if (diff === 0n) return 0n;
  return amount1 * Q96 / diff;
}

// src/evm/utils/multicurveLiquidity.ts
function getMaxLiquiditySafeMulticurveTickUpper(params) {
  if (params.tickUpper <= params.tickLower) {
    throw new Error(
      `Unable to find a uint128-safe multicurve max tick below ${params.tickUpper}`
    );
  }
  if (isCanonicalCurveLiquiditySafe(params)) return params.tickUpper;
  for (let candidate = params.tickUpper - params.tickSpacing; candidate > params.tickLower; candidate -= params.tickSpacing) {
    if (isCanonicalCurveLiquiditySafe({ ...params, tickUpper: candidate })) {
      return candidate;
    }
  }
  throw new Error(
    `Unable to find a uint128-safe multicurve max tick below ${params.tickUpper}`
  );
}
function isCanonicalCurveLiquiditySafe(params) {
  return isAdjustedCurveLiquiditySafe({
    ...params,
    isToken0: true
  }) && isAdjustedCurveLiquiditySafe({
    ...params,
    tickLower: -params.tickUpper,
    tickUpper: -params.tickLower,
    isToken0: false
  });
}
function isAdjustedCurveLiquiditySafe(params) {
  if (params.numPositions <= 0 || params.tickSpacing <= 0) {
    throw new Error("Multicurve positions and tick spacing must be positive");
  }
  const amountPerPosition = params.curveSupply / BigInt(params.numPositions);
  if (amountPerPosition <= 1n) return true;
  const amount = amountPerPosition - 1n;
  const maxLiquidityPerTick = getMaxLiquidityPerTick(params.tickSpacing);
  const liquidityByTick = /* @__PURE__ */ new Map();
  const farTick = params.isToken0 ? params.tickUpper : params.tickLower;
  const closeTick = params.isToken0 ? params.tickLower : params.tickUpper;
  const spread = params.tickUpper - params.tickLower;
  const farSqrtPriceX96 = getSqrtRatioAtTick(farTick);
  for (let i = 0; i < params.numPositions; i++) {
    const tickDelta = Number(
      BigInt(i) * BigInt(spread) / BigInt(params.numPositions)
    );
    const unalignedTick = params.isToken0 ? closeTick + tickDelta : closeTick - tickDelta;
    const startingTick = alignMulticurveTick(
      params.isToken0,
      unalignedTick,
      params.tickSpacing
    );
    if (startingTick === farTick) continue;
    const startingSqrtPriceX96 = getSqrtRatioAtTick(startingTick);
    const liquidity = params.isToken0 ? getLiquidityForAmount0(startingSqrtPriceX96, farSqrtPriceX96, amount) : getLiquidityForAmount1(farSqrtPriceX96, startingSqrtPriceX96, amount);
    if (liquidity > maxLiquidityPerTick) return false;
    const tickA = Math.min(farTick, startingTick);
    const tickB = Math.max(farTick, startingTick);
    if (!addTickLiquidity(liquidityByTick, tickA, liquidity, maxLiquidityPerTick)) {
      return false;
    }
    if (!addTickLiquidity(liquidityByTick, tickB, liquidity, maxLiquidityPerTick)) {
      return false;
    }
  }
  return true;
}
function getMaxLiquidityPerTick(tickSpacing) {
  const minTick = Math.trunc(MIN_TICK / tickSpacing) * tickSpacing;
  const maxTick = Math.trunc(MAX_TICK / tickSpacing) * tickSpacing;
  const numTicks = BigInt((maxTick - minTick) / tickSpacing + 1);
  return MAX_UINT128 / numTicks;
}
function addTickLiquidity(liquidityByTick, tick, liquidity, maxLiquidityPerTick) {
  const updatedLiquidity = (liquidityByTick.get(tick) ?? 0n) + liquidity;
  if (updatedLiquidity > maxLiquidityPerTick) return false;
  liquidityByTick.set(tick, updatedLiquidity);
  return true;
}
function alignMulticurveTick(isToken0, tick, tickSpacing) {
  if (isToken0) {
    return tick < 0 ? Math.trunc((tick - tickSpacing + 1) / tickSpacing) * tickSpacing : Math.trunc(tick / tickSpacing) * tickSpacing;
  }
  return tick < 0 ? Math.trunc(tick / tickSpacing) * tickSpacing : Math.trunc((tick + tickSpacing - 1) / tickSpacing) * tickSpacing;
}


export { getMaxLiquiditySafeMulticurveTickUpper };
