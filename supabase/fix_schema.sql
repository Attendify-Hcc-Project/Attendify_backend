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

-- Done! The attendance table already has all required columns.
SELECT 'Schema fix complete! full_name and notes columns are ready.' AS result;
