require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');

async function main() {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
    },
    realtime: {
      transport: ws,
    },
  });

  let query = supabase
    .from('attendance')
    .select(`
      *,
      members (
        first_name,
        last_name,
        full_name,
        department,
        profile_photo_url
      )
    `, { count: 'exact' });
  
  query = query.range(0, 9).order('date', { ascending: false }).order('time', { ascending: false });

  const { data, count, error } = await query;
  console.log("Error:", error);
  console.log("Count:", count);
  console.log("Data:", JSON.stringify(data, null, 2));
}

main();
