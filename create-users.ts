import { createClient } from '@supabase/supabase-js';
import * as dotenv from 'dotenv';
dotenv.config();

// Ensure global WebSocket is available for Node 20
if (!(global as any).WebSocket) {
  (global as any).WebSocket = require('ws');
}

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseKey) {
  throw new Error("Missing Supabase variables in .env");
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function createUsers() {
  const users = [
    { email: 'sunnytoby9@gmail.com', password: '20022002', role: 'Usher' },
    { email: 'triumphcodes@gmail.com', password: '20022002', role: 'First-Timer Officer' }
  ];

  for (const u of users) {
    let { data: usersData, error: userError } = await supabase.auth.admin.listUsers();
    let existingUser = usersData?.users?.find(user => user.email === u.email);

    if (existingUser) {
      console.log(`User ${u.email} already exists, updating role and password...`);
      const { data, error } = await supabase.auth.admin.updateUserById(existingUser.id, {
        password: u.password,
        user_metadata: { full_name: u.role },
        app_metadata: { role: u.role }
      });
      if (error) console.error(`Failed to update ${u.email}:`, error.message);
      else console.log(`Successfully updated ${u.email} with role ${u.role}`);
    } else {
      console.log(`Creating user ${u.email}...`);
      const { data, error } = await supabase.auth.admin.createUser({
        email: u.email,
        password: u.password,
        email_confirm: true,
        user_metadata: { full_name: u.role },
        app_metadata: { role: u.role }
      });
  
      if (error) {
        console.error(`Failed to create ${u.email}:`, error.message);
      } else {
        console.log(`Successfully created ${u.email} with role ${u.role}`);
      }
    }
  }
}

createUsers();
