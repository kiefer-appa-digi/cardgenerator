import type {
  Gs1Capabilities,
  Gs1ConnectionTest,
  Gs1DigitalLinkResolution,
  Gs1Error,
  Gs1ErrorCode,
  Gs1ProductRecord,
  Gs1PublishReceipt,
  Gs1Provider,
  Gs1Result,
  Gs1VerifyResult,
} from "./types";
import { makeGs1Error } from "./types";

/**
 * THE GS1 ADAPTER INTERFACE — spec §13.
 *
 * "Build GS1 as an adapter/service layer, not as hard-coded UI calls." Every
 * caller in the application depends on this interface and never on a provider.
 * Swapping Verified by GS1 for Data Hub, or for nothing at all, is a change to
 * one factory call.
 *
 * SERVER ONLY. Implementations hold a decrypted credential in a closure. They
 * must be constructed inside a server action, route handler or job — never in a
 * client component, never in shared code that a client component imports. This
 * file does not import `server-only` on purpose: these modules are unit-tested
 * as plain functions with an injected `fetch`, and `server-only` would break
 * that. The constraint is enforced by review and by keeping the only factory
 * (`index.ts`) out of every client import path.
 *
 * Contract for every method: it resolves. It does not reject. A network failure,
 * a 500, an expired token and "GS1 was never configured" are all `ok: false`
 * with a typed code. The only way any of these can throw is a bug, and the
 * concrete adapters are written so the whole body is inside a guard.
 */
export interface Gs1Adapter {
  readonly provider: Gs1Provider;
  readonly capabilities: Gs1Capabilities;

  /**
   * Cheap authenticated round trip (§13B "connection test"). Returns a report
   * rather than a Gs1Result because a failed test is a normal, displayable
   * outcome of the settings screen, not an exceptional one.
   */
  testConnection(): Promise<Gs1ConnectionTest>;

  /**
   * §13A. Confirm a GTIN is licensed and, where the provider returns them,
   * carry back the licence attributes. A registry that answers "no such GTIN"
   * is a successful verification with `status: "not-found"`.
   */
  verifyGtin(gtin: string): Promise<Gs1Result<Gs1VerifyResult>>;

  /** §13A. Full attribute set for a GTIN, normalised to `Gs1ProductRecord`. */
  fetchProduct(gtin: string): Promise<Gs1Result<Gs1ProductRecord>>;

  /**
   * §13B. Create or update the organisation's own record. Only meaningful when
   * `capabilities.publish` is true; other providers answer `UNSUPPORTED`.
   */
  publishProduct(record: Gs1ProductRecord): Promise<Gs1Result<Gs1PublishReceipt>>;

  /**
   * DIGITAL LINK EXTENSION POINT — optional by design, not stubbed.
   *
   * Present only when `capabilities.digitalLinkResolution` is true. No provider
   * implements it today because resolution needs a resolver the deployment owns;
   * building and parsing Digital Link URIs, which is what the QR symbology
   * actually needs, is already available from `digital-link.ts` with no adapter
   * at all. A future provider adds this method and flips the capability; callers
   * that already check the capability keep working unchanged.
   */
  resolveDigitalLink?(uri: string): Promise<Gs1Result<Gs1DigitalLinkResolution>>;
}

export const NO_CAPABILITIES: Gs1Capabilities = {
  verify: false,
  fetchProduct: false,
  publish: false,
  digitalLinkResolution: false,
};

/** True when the adapter actually implements the optional resolution method. */
export function supportsDigitalLinkResolution(
  adapter: Gs1Adapter,
): adapter is Gs1Adapter & Required<Pick<Gs1Adapter, "resolveDigitalLink">> {
  return adapter.capabilities.digitalLinkResolution && typeof adapter.resolveDigitalLink === "function";
}

/**
 * Wrap an adapter method so a programming error inside it still surfaces as a
 * typed failure. The interface promises "never throws for an expected failure";
 * this makes the promise hold for unexpected ones too, which matters because a
 * batch export must not die because a third-party mapper hit an undefined.
 */
export async function guarded<T>(
  operation: () => Promise<Gs1Result<T>>,
  onThrow: (message: string) => Gs1Error,
): Promise<Gs1Result<T>> {
  try {
    return await operation();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: onThrow(message) };
  }
}

/** The single place the "GS1 is off" error text is written. */
export function notConfiguredError(detail: string): Gs1Error {
  return makeGs1Error(
    "NOT_CONFIGURED",
    "GS1 is not configured for this organisation.",
    { retryable: false, attempts: 0, detail },
  );
}

export function unsupportedError(operation: string, provider: Gs1Provider): Gs1Error {
  return makeGs1Error(
    "UNSUPPORTED",
    `The ${provider} connector does not support ${operation}.`,
    { retryable: false, attempts: 0 },
  );
}

/** Codes a caller should surface as "try again later" rather than "fix this". */
const TRANSIENT: ReadonlySet<Gs1ErrorCode> = new Set<Gs1ErrorCode>([
  "RATE_LIMITED",
  "TIMEOUT",
  "NETWORK",
  "SERVER_ERROR",
]);

export function isTransient(error: Gs1Error): boolean {
  return TRANSIENT.has(error.code);
}
