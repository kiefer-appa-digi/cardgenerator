import QRCode from "qrcode";
import type { BarcodeError } from "./types";
import { digitalLinkUri, normaliseGtin14, type DigitalLinkOptions } from "./gtin";

/**
 * QR and GS1 Digital Link — spec §12 and §13.
 *
 * The `qrcode` package does the Reed-Solomon and masking work and hands back a
 * BitMatrix. Everything past that point is ours: we never ask it for a PNG or
 * an SVG string, because a rasterised barcode in a production PDF is a defect
 * (§12). One rect per dark module keeps the output a pure vector and leaves any
 * run-merging decision to the PDF writer, which knows its own operator costs.
 */

/** Error correction level M — the GS1 Digital Link recommendation for retail. */
export const QR_ERROR_CORRECTION = "M" as const;

/** QR requires a light margin of 4 modules on all four sides. */
export const QR_QUIET_MODULES = 4;

/**
 * GS1 General Specifications X-dimension for GS1 QR Code on retail trade items:
 * 0.396 mm minimum, 0.615 mm target, 0.990 mm maximum. The target is 100 %.
 */
export const NOMINAL_X_QR_UPT = 1_743_307; // 0.615 mm
export const QR_MIN_MAGNIFICATION_BPS = 6_450; // X = 0.3967 mm
export const QR_MAX_MAGNIFICATION_BPS = 16_090; // X = 0.9896 mm

export type QrMatrix = {
  /** Modules per side, quiet zone excluded. */
  size: number;
  /** Row-major, `true` where the module is dark. Length is size * size. */
  dark: readonly boolean[];
  version: number;
};

export type QrResult =
  | { ok: true; matrix: QrMatrix; encodedValue: string; notes: string[] }
  | { ok: false; error: BarcodeError };

function toMatrix(text: string): QrResult {
  try {
    const qr = QRCode.create(text, { errorCorrectionLevel: QR_ERROR_CORRECTION });
    const size = qr.modules.size;
    const data = qr.modules.data;
    const dark: boolean[] = new Array<boolean>(size * size);
    for (let i = 0; i < size * size; i += 1) dark[i] = data[i] === 1;
    return { ok: true, matrix: { size, dark, version: qr.version }, encodedValue: text, notes: [] };
  } catch (e) {
    // The package throws for over-capacity data and for unencodable input; both
    // are the caller's problem, and both are reportable rather than fatal.
    const message = e instanceof Error ? e.message : "QR encoding failed";
    return {
      ok: false,
      error: {
        code: /too (big|long)|code length overflow/i.test(message) ? "TOO_LONG" : "UNSUPPORTED",
        message,
        value: text,
      },
    };
  }
}

/** Plain QR: the value is encoded verbatim. */
export function encodeQr(value: string): QrResult {
  if (value.trim().length === 0) {
    return { ok: false, error: { code: "EMPTY", message: "no barcode value supplied", value } };
  }
  return toMatrix(value);
}

/**
 * GS1 Digital Link: the value is a GTIN (any length), normalised to GTIN-14 and
 * turned into a canonical `<domain>/01/<gtin14>` URI before encoding. Anything
 * that already looks like an http(s) URI is encoded as given, so an operator can
 * paste a resolver URL that carries qualifiers we do not model.
 */
export function encodeDigitalLink(value: string, opts: DigitalLinkOptions = {}): QrResult {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: { code: "EMPTY", message: "no barcode value supplied", value } };
  }
  if (/^https?:\/\//i.test(trimmed)) {
    const direct = toMatrix(trimmed);
    if (direct.ok) direct.notes.push("value encoded as a supplied Digital Link URI");
    return direct;
  }

  const gtin = normaliseGtin14(trimmed);
  if (!gtin.ok) return { ok: false, error: gtin.error };

  const uri = digitalLinkUri(gtin.value.gtin, opts);
  const matrix = toMatrix(uri);
  if (matrix.ok) matrix.notes.push(...gtin.value.notes);
  return matrix;
}
