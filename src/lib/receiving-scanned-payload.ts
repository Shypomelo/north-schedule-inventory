import { normalizeSerialInput } from './inventory-serial-normalization';

export interface ParsedScannedPayload {
  raw: string;
  composite: boolean;
  candidates: string[];
}

// Separators observed in the phone payload or emitted as field separators by
// barcode decoders. No field positions or implicit token joins are assumed.
const FIELD_SEPARATOR = /[|\r\n\t\x1d]/;
const FIELD_SEPARATORS = /[|\r\n\t\x1d]+/;

export function parseScannedPayload(raw: string): ParsedScannedPayload {
  const composite = FIELD_SEPARATOR.test(raw);
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const part of composite ? raw.split(FIELD_SEPARATORS) : [raw]) {
    const token = part.trim();
    const normalized = normalizeSerialInput(token);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    candidates.push(token);
  }
  return { raw, composite, candidates };
}

/** Only unambiguous structural fragments are suppressed from UNKNOWN display. */
export function isStructuralMetadataToken(token: string): boolean {
  const value = token.trim();
  if (/^[0-9]{1,2}$/.test(value) || /^[A-Z]$/i.test(value)) return true;
  if (!/^20[0-9]{6}$/.test(value)) return false;
  const year = Number(value.slice(0, 4)), month = Number(value.slice(4, 6)), day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() + 1 === month && date.getUTCDate() === day;
}
