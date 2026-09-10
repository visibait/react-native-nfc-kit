/**
 * Reading an Apple Wallet pass, at `react-native-nfc-kit/vas`.
 *
 * ```ts
 * import { vas } from 'react-native-nfc-kit/vas';
 *
 * const [response] = await vas.read({
 *   configurations: [{ passTypeIdentifier: 'pass.es.ventry.entrada' }],
 * });
 * ```
 *
 * iOS only, and it needs an entitlement Apple grants case by case. See
 * `src/vas/vas.ts` for what that means in practice, and `docs/setup/vas.md` for
 * the setup.
 */

export { vas } from './vas.js';
export { VAS_MODES, VAS_STATUS } from './vas.js';
export type { VasConfiguration, VasOptions, VasResponse } from './vas.js';
export type { VasMode, VasStatusName } from '../native/contract.js';
