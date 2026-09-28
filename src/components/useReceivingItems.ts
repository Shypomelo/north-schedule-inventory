'use client';
import { useState } from 'react';
import type { InventoryItem } from '@/lib/db/types';
import type { ReceivingSnapshot } from '@/lib/receiving-v5';
import type { ReceivingV5Api } from '@/lib/db/receiving-v5';

export function useReceivingItems<T extends ReceivingSnapshot>(initial: T, api: ReceivingV5Api) {
  const [added, setAdded] = useState<InventoryItem[]>([]);
  const items = [...initial.items, ...added.filter(i => !initial.items.some(old => old.id === i.id))];
  const createItem = async (key: string, unit: string, requiresSerial: boolean) => {
    const { item } = await api.createItem({ p_identity_key: key, p_unit: unit, p_requires_serial: requiresSerial });
    setAdded(previous => [...previous.filter(i => i.id !== item.id), item]);
    return item;
  };
  return { data: { ...initial, items } as T, createItem };
}
