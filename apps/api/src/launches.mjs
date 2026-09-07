import { StonksLive } from './stonks-live.mjs';
import { LongLive } from './long-live.mjs';
import { O1Live } from './o1-live.mjs';
import { launchpadForPair } from './launch-catalog.mjs';

import { PonsLive } from "./pons-live.mjs";

export class Launches {
  constructor(config, upstream, budget) {
    this.budget = budget;
    this.db = budget.db;
    this.handlers = {
      stonks: new StonksLive(config, upstream, budget),
      pons: new PonsLive(config, upstream, budget),
      long: new LongLive(config, upstream, budget),
      longbow: new LongLive({ ...config, longLaunch: config.longbowLaunch }, upstream, budget),
      o1: new O1Live(config, upstream, budget),
      o1Base: new O1Live({ ...config, o1Launch: config.o1BaseLaunch }, upstream, budget),
    };
  }
  run(kind, input) {
    const saved = input?.id && this.db.prepare('SELECT context FROM long_launches WHERE id=?').get(input.id);
    const context = saved ? JSON.parse(saved.context) : input;
    const pad = launchpadForPair(context?.pairId);
    const handler = pad === 'o1' && context?.chainId === 8453 ? this.handlers.o1Base : this.handlers[pad];
    return this.budget.withLaunch(() => handler.run(kind, input));
  }
}
