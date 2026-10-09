'use client';

import { useEffect, useState } from 'react';
import { supabase } from '@/lib/db/supabaseClient';
import { useUser } from './UserContext';

export function useSystemOwner() {
  const { currentUser } = useUser();
  const [isOwner, setIsOwner] = useState(false);

  useEffect(() => {
    setIsOwner(false);
    if (currentUser?.role !== 'ADMIN') return;
    let live = true;
    void supabase.rpc('is_system_owner').then(({ data, error }) => {
      if (live) setIsOwner(!error && data === true);
    });
    return () => { live = false; };
  }, [currentUser?.id, currentUser?.role]);

  return isOwner;
}
