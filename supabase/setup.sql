-- ============================================================
-- Attendify Database Setup Script
-- Run this in the Supabase SQL Editor to ensure all tables
-- and storage buckets are correctly created.
-- ============================================================

-- ============================
-- 1. MEMBERS TABLE
-- ============================
CREATE TABLE IF NOT EXISTS public.members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  full_name TEXT NOT NULL,
  phone_number TEXT,
  email TEXT,
  gender TEXT NOT NULL CHECK (gender IN ('Male', 'Female')),
  date_of_birth DATE,
  department TEXT,
  membership_status TEXT NOT NULL DEFAULT 'Active',
  profile_photo_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add missing columns if they don't exist (safe to run multiple times)
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS phone_number TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS email TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS department TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS profile_photo_url TEXT;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS date_of_birth DATE;
ALTER TABLE public.members ADD COLUMN IF NOT EXISTS membership_status TEXT NOT NULL DEFAULT 'Active';

-- ============================
-- 2. MEMBER FACES TABLE
-- ============================
CREATE TABLE IF NOT EXISTS public.member_faces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  face_type TEXT NOT NULL CHECK (face_type IN ('front', 'left', 'right')),
  photo_url TEXT,
  embedding TEXT, -- stored as JSON string array
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================
-- 3. CAMERAS TABLE (camera_streams)
-- ============================
CREATE TABLE IF NOT EXISTS public.camera_streams (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  location TEXT,
  rtsp_url TEXT,
  status TEXT NOT NULL DEFAULT 'Offline',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================
-- 4. VISITORS TABLE
-- ============================
CREATE TABLE IF NOT EXISTS public.visitors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  camera_id UUID REFERENCES public.camera_streams(id) ON DELETE SET NULL,
  captured_face_url TEXT,
  snapshot_url TEXT,
  detection_date DATE NOT NULL DEFAULT CURRENT_DATE,
  detection_time TIME NOT NULL DEFAULT CURRENT_TIME,
  status TEXT NOT NULL DEFAULT 'Pending' CHECK (status IN ('Pending', 'Registered', 'Ignored')),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add missing columns if they don't exist
ALTER TABLE public.visitors ADD COLUMN IF NOT EXISTS captured_face_url TEXT;
ALTER TABLE public.visitors ADD COLUMN IF NOT EXISTS snapshot_url TEXT;
ALTER TABLE public.visitors ADD COLUMN IF NOT EXISTS detection_date DATE NOT NULL DEFAULT CURRENT_DATE;
ALTER TABLE public.visitors ADD COLUMN IF NOT EXISTS detection_time TIME NOT NULL DEFAULT CURRENT_TIME;
ALTER TABLE public.visitors ADD COLUMN IF NOT EXISTS notes TEXT;

-- ============================
-- 5. ATTENDANCE TABLE
-- ============================
CREATE TABLE IF NOT EXISTS public.attendance (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id UUID NOT NULL REFERENCES public.members(id) ON DELETE CASCADE,
  camera_id UUID REFERENCES public.camera_streams(id) ON DELETE SET NULL,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  time TIME NOT NULL DEFAULT CURRENT_TIME,
  service_type TEXT NOT NULL DEFAULT 'Practice / Testing Session',
  status TEXT NOT NULL DEFAULT 'Present',
  marked_by TEXT,
  punctuality_status TEXT,
  minutes_difference INTEGER,
  confidence_score FLOAT,
  source TEXT DEFAULT 'camera', -- 'camera' | 'kiosk' | 'manual'
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Add compatibility columns to existing table
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS date DATE;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS time TIME;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS service_type TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS status TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS marked_by TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS punctuality_status TEXT;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS minutes_difference INTEGER;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS attendance_date DATE;
ALTER TABLE public.attendance ADD COLUMN IF NOT EXISTS check_in_time TIME;

-- ============================
-- 6. ROW LEVEL SECURITY (optional but recommended)
-- ============================
-- Disable RLS for service role access (the backend uses a service role key)
ALTER TABLE public.members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_faces ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.visitors ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.attendance ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.camera_streams ENABLE ROW LEVEL SECURITY;

-- Allow service role to do everything (your backend uses the service role key)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'members' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON public.members FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'member_faces' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON public.member_faces FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'visitors' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON public.visitors FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'attendance' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON public.attendance FOR ALL TO service_role USING (true);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'camera_streams' AND policyname = 'service_role_all') THEN
    CREATE POLICY service_role_all ON public.camera_streams FOR ALL TO service_role USING (true);
  END IF;
END $$;

-- ============================
-- 7. STORAGE BUCKETS
-- ============================
-- Run this in the Supabase SQL editor to create the storage buckets if they don't exist.
-- (You can also do this from the Supabase Dashboard > Storage)
INSERT INTO storage.buckets (id, name, public)
VALUES ('member-photos', 'member-photos', true)
ON CONFLICT (id) DO NOTHING;

INSERT INTO storage.buckets (id, name, public)
VALUES ('visitor-images', 'visitor-images', true)
ON CONFLICT (id) DO NOTHING;

-- Storage policies for service role
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'objects' AND policyname = 'service_role_storage_all') THEN
    CREATE POLICY service_role_storage_all ON storage.objects FOR ALL TO service_role USING (true);
  END IF;
END $$;

SELECT 'Attendify database setup complete! All tables and storage buckets are ready.' AS result;
