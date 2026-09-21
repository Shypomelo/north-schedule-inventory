import { classifySerialFormat } from '@/lib/inventory-serial-normalization';
import { InventoryBatch, InventorySerial, TransactionType } from '@/lib/db/types';

export type AvailableInventorySerial = InventorySerial & { in_date: string };

interface GetAvailableSerialsOptions {
  allSerials: InventorySerial[];
  batches: InventoryBatch[];
  itemId: string;
  transactionType: TransactionType;
  requiresSerial: boolean;
  isEditMode: boolean;
  initialSerials: string[];
}

export function getAvailableSerialsFIFO({
  allSerials,
  batches,
  itemId,
  transactionType,
  requiresSerial,
  isEditMode,
  initialSerials,
}: GetAvailableSerialsOptions): AvailableInventorySerial[] {
  if (!requiresSerial || !itemId) return [];

  const allowedStatus = transactionType === 'RETURN' ? '已出庫' : '在庫';
  const batchInDates = new Map(batches.map(batch => [batch.id, batch.in_date]));

  return allSerials
    .filter(serial => (
      serial.item_id === itemId
      && classifySerialFormat(serial.serial_number) !== 'unknown'
      && (serial.status === allowedStatus || (isEditMode && initialSerials.includes(serial.serial_number)))
    ))
    .map(serial => ({
      ...serial,
      in_date: serial.batch_id ? batchInDates.get(serial.batch_id) || '9999-12-31' : '9999-12-31',
    }))
    .sort((a, b) => {
      const dateDiff = new Date(a.in_date).getTime() - new Date(b.in_date).getTime();
      if (dateDiff !== 0) return dateDiff;
      return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
    });
}

export function filterAvailableSerials<T extends { serial_number: string }>(
  availableSerials: T[],
  input: string,
): T[] {
  const query = input.trim().toLocaleLowerCase();
  if (!query) return availableSerials;

  return availableSerials.filter(serial => serial.serial_number.toLocaleLowerCase().includes(query));
}

export function findExactAvailableSerial<T extends { serial_number: string }>(
  availableSerials: T[],
  input: string,
): T | undefined {
  const query = input.trim().toLocaleLowerCase();
  if (!query) return undefined;

  return availableSerials.find(serial => serial.serial_number.toLocaleLowerCase() === query);
}

export function getNoAvailableSerialMatchMessage(transactionType: TransactionType): string {
  return transactionType === 'RETURN'
    ? String.fromCodePoint(25214, 19981, 21040, 31526, 21512, 30340, 21487, 36864, 26009, 24207, 34399)
    : String.fromCodePoint(25214, 19981, 21040, 31526, 21512, 30340, 21487, 20986, 24235, 24207, 34399);
}
