ALTER TABLE public.se_supply_records
ADD COLUMN IF NOT EXISTS new_model text;
