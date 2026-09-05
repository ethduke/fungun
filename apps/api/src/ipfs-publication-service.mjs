import { ServiceError } from "./errors.mjs";

export function publicationStore(legacy, ipfs, worker, selected = false) {
  return {
    budget: legacy.budget,
    clock: () => selected ? ipfs.clock() : legacy.clock(),
    read: (name) => legacy.read(name),
    challenge: (...args) => selected ? ipfs.challenge(...args) : legacy.challenge(...args),
    launchChallenge: (...args) => {
      if (!selected || !ipfs) throw new ServiceError("ipfs_publication_disabled");
      return ipfs.launchChallenge(...args);
    },
    launchPublish: async (input) => {
      if (!selected || !ipfs) throw new ServiceError("ipfs_publication_disabled");
      const result = await ipfs.acceptLaunch(input);
      worker?.kick();
      return result;
    },
    publish: async (input) => {
      if (!ipfs?.get(input.id)) return legacy.publish(input);
      const result = await ipfs.accept(input);
      worker?.kick();
      return result;
    },
    status: (input) => ipfs?.get(input.id) ? ipfs.status(input) : legacy.status(input),
  };
}
