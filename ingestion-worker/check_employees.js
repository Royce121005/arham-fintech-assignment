require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

async function check() {
  const { data: employees, error: empErr } = await db.from('employees').select('*');
  if (empErr) {
    console.error('Employees error:', empErr);
    return;
  }
  console.log('Employees in database:');
  console.table(employees.map(e => ({
    employee_id: e.employee_id,
    name: e.name,
    role: e.role,
    user_id: e.user_id
  })));
  
  const { data: syncState, error: syncErr } = await db.from('sync_state').select('*');
  console.log('\nSync State:');
  console.table(syncState);
}

check();
