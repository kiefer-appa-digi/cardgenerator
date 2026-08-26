import type { Gs1Adapter } from "../adapter";
import { NO_CAPABILITIES, notConfiguredError } from "../adapter";
import type {
  Gs1ConnectionTest,
  Gs1ProductRecord,
  Gs1PublishReceipt,
  Gs1Result,
  Gs1VerifyResult,
} from "../types";
import { gs1Err } from "../types";

/**
 * THE DEFAULT ADAPTER — spec §13: "The integration must work even if GS1 is not
 * configured. GS1 is an optional connected service, not a hard runtime
 * dependency."
 *
 * This is what `getAdapter` returns for every organisation that has not set GS1
 * up, and also for one that has set it up wrongly (no base URL, no credential).
 * It performs no I/O, has no dependencies, and answers instantly. Every code
 * path that touches GS1 is exercised by this adapter in development and in
 * tests, which is the point: if the application only works when GS1 is
 * configured, GS1 has become a dependency.
 *
 * It answers `NOT_CONFIGURED` rather than an empty success so a caller cannot
 * mistake "we asked nobody" for "GS1 has no data for this GTIN".
 */
export function createDisabledAdapter(reason = ""): Gs1Adapter {
  const detail =
    reason === ""
      ? "No GS1 connection is enabled. Add one under Settings → Integrations."
      : reason;
  const error = () => notConfiguredError(detail);

  const nowIso = () => new Date().toISOString();

  return {
    provider: "disabled",
    capabilities: NO_CAPABILITIES,

    async testConnection(): Promise<Gs1ConnectionTest> {
      return {
        ok: false,
        provider: "disabled",
        host: "",
        detail,
        latencyMs: 0,
        checkedAt: nowIso(),
        error: error(),
      };
    },

    async verifyGtin(): Promise<Gs1Result<Gs1VerifyResult>> {
      return gs1Err(error());
    },

    async fetchProduct(): Promise<Gs1Result<Gs1ProductRecord>> {
      return gs1Err(error());
    },

    async publishProduct(): Promise<Gs1Result<Gs1PublishReceipt>> {
      return gs1Err(error());
    },
  };
}

/** Shared instance for the common case. Stateless, so sharing is safe. */
export const DISABLED_ADAPTER: Gs1Adapter = createDisabledAdapter();
