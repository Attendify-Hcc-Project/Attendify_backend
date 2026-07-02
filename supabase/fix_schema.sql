-- ============================================================
-- Attendify Schema Fix Migration (SAFE - Minimal)
-- Run this in the Supabase SQL Editor.
-- All statements use IF NOT EXISTS so they are safe to run
-- even if the columns already exist.
-- ============================================================

-- 1. Add full_name to members table (the error column!)
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS full_name TEXT;

-- 2. Backfill full_name for ALL existing members
UPDATE public.members
SET full_name = TRIM(first_name || ' ' || last_name)
WHERE full_name IS NULL OR full_name = '';

-- 3. Add notes column to visitors table (stores face descriptor for recognition)
ALTER TABLE public.visitors ADD COLUMN IF NOT EXISTS notes TEXT;

-- 4. Add attendance columns expected by the backend
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS time TIME;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS service_type TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS marked_by TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS punctuality_status TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS minutes_difference INTEGER;

-- Done! The schema now supports visitor capture and AI attendance marking.
SELECT 'Schema fix complete! full_name, notes, and attendance columns are ready.' AS result;
