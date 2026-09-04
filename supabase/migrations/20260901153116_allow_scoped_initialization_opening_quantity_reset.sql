create or replace function app_private.reject_locked_inventory_item_opening_quantity_change()
returns trigger
language plpgsql
security definer
set search_path to 'pg_catalog'
as $function$
declare
  v_initialization_id_text text;
begin
  if old.opening_quantity is not distinct from new.opening_quantity then
    return new;
  end if;

  v_initialization_id_text := nullif(
    pg_catalog.current_setting('app.inventory_initialization_id', true),
    ''
  );

  if v_initialization_id_text is not null
     and exists (
       select 1
       from public.inventory_initializations initialization
       where initialization.id = v_initialization_id_text::uuid
         and initialization.initialized_by = auth.uid()::text
     ) then
    return new;
  end if;

  if exists (
    select 1
    from public.inventory_monthly_closing_items closing_item
    where closing_item.inventory_item_id = old.id
  ) then
    raise exception '此品項已有月結紀錄，初始庫存已鎖定，請使用庫存調整'
      using errcode = 'check_violation';
  end if;

  return new;
end;
$function$;
