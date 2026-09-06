import { LongLive } from './long-live.mjs';
import { O1Live } from './o1-live.mjs';
import { launchpadForPair } from './launch-catalog.mjs';

export class Launches {
  constructor(config, upstream, budget) {
    this.budget = budget;
    this.db = budget.db;
    this.handlers = {
      long: new LongLive(config, upstream, budget),
      longbow: new LongLive({ ...config, longLaunch: config.longbowLaunch }, upstream, budget),
      o1: new O1Live(config, upstream, budget),
    };
  }
  run(kind, input) {
    const saved = input?.id && this.db.prepare('SELECT context FROM long_launches WHERE id=?').get(input.id);
    const pair = saved ? JSON.parse(saved.context).pairId : input?.pairId;
    return this.handlers[launchpadForPair(pair)].run(kind, input);
  }
}
