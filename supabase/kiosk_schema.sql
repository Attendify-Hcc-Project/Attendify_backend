-- 1. Add qr_code and address to members table
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS qr_code TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS address TEXT;

-- 2. Add method to attendance table
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS method TEXT;
