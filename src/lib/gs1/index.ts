import type { Gs1Adapter } from "./adapter";
import { createDisabledAdapter } from "./providers/disabled";
import type { Gs1UsDeps } from "./providers/gs1us";
import { createGs1UsAdapter } from "./providers/gs1us";
import type { Gs1ConnectionConfig } from "./types";
import { Gs1ConnectionConfigSchema } from "./types";

/**
 * GS1 SERVICE ENTRY POINT — spec §13.
 *
 * SERVER ONLY. Importing this module pulls in the credential-handling code path;
 * a client component must import `./types` (pure zod/TS, no secrets, no
 * `node:crypto`) instead. Nothing here reads a database or the environment: the
 * caller decrypts the stored credential with `@/server/crypto` and hands over a
 * fully-formed config, which keeps this module a pure function of its input and
 * keeps the credential's lifetime as short as the request.
 *
 * The factory always returns a working adapter. There is no null branch and no
 * throw, because §13 requires the application to work with GS1 switched off:
 * every misconfiguration degrades to the disabled adapter with a reason a
 * settings screen can display.
 */

export type Gs1AdapterDeps = Partial<Gs1UsDeps>;

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "https:" || parsed.protocol === "http:";
  } catch {
    return false;
  }
}

function reasonToDisable(config: Gs1ConnectionConfig): string | null {
  if (config.provider === "disabled") return "No GS1 connection is enabled. Add one under Settings → Integrations.";
  if (!config.enabled) return "The GS1 connection exists but is switched off.";
  if (config.baseUrl.trim() === "") return "The GS1 connection has no base URL.";
  // An unparseable base URL is a settings mistake, and saying so once beats
  // returning a NETWORK error on every product in a batch of two hundred.
  if (!isHttpUrl(config.baseUrl.trim())) {
    return "The GS1 base URL is not a valid http(s) URL.";
  }
  if (config.authMode !== "none" && config.credential === "") {
    return "The GS1 connection has no stored credential, or it could not be decrypted.";
  }
  return null;
}

/**
 * Build the adapter for one organisation's connection row.
 *
 * `deps.fetch` is optional only as a convenience for production, where the
 * platform global is the right implementation. Tests always inject one; the
 * global is read at call time, never at module scope.
 */
export function getAdapter(config: Gs1ConnectionConfig, deps: Gs1AdapterDeps = {}): Gs1Adapter {
  const parsed = Gs1ConnectionConfigSchema.safeParse(config);
  if (!parsed.success) {
    return createDisabledAdapter("The stored GS1 connection settings are invalid.");
  }
  const cfg = parsed.data;

  const disableReason = reasonToDisable(cfg);
  if (disableReason !== null) return createDisabledAdapter(disableReason);

  const fetchImpl = deps.fetch ?? (globalThis.fetch as Gs1UsDeps["fetch"] | undefined);
  if (fetchImpl === undefined) {
    return createDisabledAdapter("No fetch implementation is available in this runtime.");
  }

  return createGs1UsAdapter(cfg, { ...deps, fetch: fetchImpl });
}

export type { Gs1Adapter } from "./adapter";
export {
  guarded,
  isTransient,
  notConfiguredError,
  NO_CAPABILITIES,
  supportsDigitalLinkResolution,
  unsupportedError,
} from "./adapter";
export { createDisabledAdapter, DISABLED_ADAPTER } from "./providers/disabled";
export {
  backoffDelayMs,
  buildPublishPayload,
  createGs1UsAdapter,
  mapGs1ProductRecord,
  parseRetryAfterMs,
} from "./providers/gs1us";
export type { Gs1Fetch, Gs1FetchInit, Gs1FetchResponse, Gs1UsDeps } from "./providers/gs1us";
export {
  applyAcceptedFields,
  diffRemoteAgainstLocal,
  GS1_FIELD_MAPPINGS,
  hasPendingDiffs,
  pendingDiffs,
} from "./diff";
export type { ApplyAcceptedFieldsResult, ApplyRejection, DiffOptions } from "./diff";
export {
  buildDigitalLinkUri,
  DEFAULT_RESOLVER_DOMAIN,
  parseDigitalLinkUri,
} from "./digital-link";
export type {
  BuildDigitalLinkInput,
  BuildDigitalLinkResult,
  DigitalLinkQualifiers,
  ParseDigitalLinkResult,
  ParsedDigitalLink,
} from "./digital-link";
export { describeGtinFailure, gtinCheckDigit, isValidGtin, normalizeGtin, toGtin14 } from "./gtin";
export type { GtinLength, GtinNormalizeResult } from "./gtin";
export * from "./types";
