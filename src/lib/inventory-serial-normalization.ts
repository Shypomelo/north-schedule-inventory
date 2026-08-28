export type InventorySerialFormat = 'full' | 'short' | 'unknown';

import type {
  InventorySerial,
  InventorySerialLookupCandidate,
  InventorySerialLookupResult,
  InventorySerialLookupResultType,
} from './db/types';

const DASH_VARIANTS = /[－–—]/g;
const SPACES_AROUND_DASH = /\s*-\s*/g;
const SHORT_SERIAL_PATTERN = /^[A-Z0-9]{9}-[A-Z0-9]{2}$/;
const FULL_SERIAL_PATTERN = /^[A-Z]{2}[0-9]{4}[A-Z]?-[A-Z0-9]{9}-[A-Z0-9]{2}$/;

export interface InventorySerialNormalizationFixture {
  input: string;
  normalized: string;
  format: InventorySerialFormat;
  shortKey: string | null;
}

export function normalizeSerialInput(input: string): string {
  return input
    .normalize('NFKC')
    .replace(DASH_VARIANTS, '-')
    .trim()
    .replace(SPACES_AROUND_DASH, '-')
    .toUpperCase();
}

export function classifySerialFormat(input: string): InventorySerialFormat {
  const normalized = normalizeSerialInput(input);

  if (SHORT_SERIAL_PATTERN.test(normalized)) return 'short';
  if (FULL_SERIAL_PATTERN.test(normalized)) return 'full';
  return 'unknown';
}

export function deriveShortSerialKey(input: string): string | null {
  const normalized = normalizeSerialInput(input);

  if (SHORT_SERIAL_PATTERN.test(normalized)) {
    return normalized;
  }

  if (FULL_SERIAL_PATTERN.test(normalized)) {
    const [, middle, tail] = normalized.split('-');
    return `${middle}-${tail}`;
  }

  return null;
}

export function resolveInventorySerialLookupFromList(
  input: string,
  serials: InventorySerial[],
  options: { itemId?: string | null; allowedStatuses?: string[] | null } = {},
): InventorySerialLookupResult {
  const normalizedInput = normalizeSerialInput(input);
  const inputShortKey = deriveShortSerialKey(input);
  const inputFormat = classifySerialFormat(input);
  const matches = new Map<string, InventorySerial>();

  serials.forEach(serial => {
    const normalizedFull = serial.normalized_full || normalizeSerialInput(serial.serial_number);
    const shortKey = serial.short_key ?? deriveShortSerialKey(serial.serial_number);

    if (normalizedFull === normalizedInput) {
      matches.set(serial.id, serial);
      return;
    }

    if ((inputFormat === 'full' || inputFormat === 'short') && inputShortKey && shortKey === inputShortKey) {
      matches.set(serial.id, serial);
    }
  });

  const candidates: InventorySerialLookupCandidate[] = Array.from(matches.values()).map(serial => {
    const normalizedFull = serial.normalized_full || normalizeSerialInput(serial.serial_number);
    const shortKey = serial.short_key ?? deriveShortSerialKey(serial.serial_number);
    const isAllowedCandidate = (!options.itemId || serial.item_id === options.itemId)
      && (!options.allowedStatuses || options.allowedStatuses.includes(serial.status));

    return {
      id: serial.id,
      item_id: serial.item_id,
      serial_number: serial.serial_number,
      normalized_full: normalizedFull,
      short_key: shortKey,
      status: serial.status,
      is_allowed_candidate: isAllowedCandidate,
    };
  });

  const exactCandidateCount = candidates.filter(candidate => candidate.normalized_full === normalizedInput).length;
  const filteredCandidateCount = candidates.filter(candidate => candidate.is_allowed_candidate).length;

  let resultType: InventorySerialLookupResultType;
  if (candidates.length === 0) {
    resultType = 'no_match';
  } else if (candidates.length > 1) {
    resultType = 'ambiguous';
  } else if (filteredCandidateCount === 0) {
    resultType = 'filtered_out';
  } else if (inputFormat === 'full' && exactCandidateCount === 0) {
    resultType = 'potential_same_identity';
  } else {
    resultType = 'unique_match';
  }

  return {
    result_type: resultType,
    candidate_count: candidates.length,
    filtered_candidate_count: filteredCandidateCount,
    candidates,
  };
}

export const INVENTORY_SERIAL_NORMALIZATION_FIXTURES: InventorySerialNormalizationFixture[] = [
  {
    input: 'SJ1823A-03068530E-F9',
    normalized: 'SJ1823A-03068530E-F9',
    format: 'full',
    shortKey: '03068530E-F9',
  },
  {
    input: 'sj1823a-03068530e-f9',
    normalized: 'SJ1823A-03068530E-F9',
    format: 'full',
    shortKey: '03068530E-F9',
  },
  {
    input: '  SJ1823A-03068530E-F9  ',
    normalized: 'SJ1823A-03068530E-F9',
    format: 'full',
    shortKey: '03068530E-F9',
  },
  {
    input: 'SJ1823A－03068530E–F9',
    normalized: 'SJ1823A-03068530E-F9',
    format: 'full',
    shortKey: '03068530E-F9',
  },
  {
    input: '03068530E-F9',
    normalized: '03068530E-F9',
    format: 'short',
    shortKey: '03068530E-F9',
  },
  {
    input: 'UNKNOWN SERIAL VALUE',
    normalized: 'UNKNOWN SERIAL VALUE',
    format: 'unknown',
    shortKey: null,
  },
  {
    input: 'ABC-123-XY',
    normalized: 'ABC-123-XY',
    format: 'unknown',
    shortKey: null,
  },
];
