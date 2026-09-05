import * as encoder from "../../web/lib/long-encoding/long-launch.mjs";
import { ServiceError as EncodingError } from "../../web/lib/long-encoding/errors.mjs";
import { ServiceError } from "./errors.mjs";

export const { LONG_CREATE_ABI, LONG_TOKEN_PARAMETERS, LONG_POOL_PARAMETERS, LONG_HOOK_PARAMETERS } = encoder;
function checked(operation, args) {
  try { return encoder[operation](...args); }
  catch (error) {
    if (error instanceof EncodingError) throw new ServiceError(error.code, error.status, error.retryAfter);
    throw error;
  }
}
export const readLongLaunchProfile = (...args) => checked("readLongLaunchProfile", args);
export const buildUnsignedLongLaunch = (...args) => checked("buildUnsignedLongLaunch", args);
export const assertUnsignedLongTransaction = (...args) => checked("assertUnsignedLongTransaction", args);
