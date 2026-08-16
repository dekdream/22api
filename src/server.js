import 'dotenv/config';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { createClient } from '@supabase/supabase-js';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'API_JWT_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key} in .env`);

const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const origins = (process.env.CLIENT_ORIGIN || '').split(',').map((x) => x.trim()).filter(Boolean);
app.use(cors({ origin: origins.length ? origins : false }));
app.use(express.json({ limit: '1mb' }));

const tableAccess = new Set(['branches', 'positions', 'employees', 'customers', 'announcements', 'payroll', 'attendance', 'services', 'service_history', 'calendar_events', 'leave_requests', 'leave_type', 'notifications']);
const employeeSelect = '*, positions(name, salary), branches(branch_code, branch_name)';

function fail(res, status, message) { return res.status(status).json({ error: message }); }
function roleFor(employee) {
  const name = String(employee.positions?.name ?? '').toLowerCase();
  if (name === 'owner') return employee.branch_id ? 'branchOwner' : 'owner';
  if (name === 'administrator' || name === 'admin') return 'admin';
  return 'employee';
}
function authorize(req, res, next) {
  const token = req.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (!token) return fail(res, 401, 'Authentication required');
  try { req.actor = jwt.verify(token, process.env.API_JWT_SECRET); return next(); }
  catch { return fail(res, 401, 'Invalid or expired token'); }
}
function canManage(actor) { return actor.role === 'owner' || actor.role === 'branchOwner' || actor.role === 'admin'; }
function scopedData(req, table, body) {
  const data = { ...body };
  if ((req.actor.role === 'branchOwner' || req.actor.role === 'admin') && ['employees', 'customers', 'announcements'].includes(table)) data.branch_id = req.actor.branch_id;
  return data;
}
function guardTable(req, res, next) {
  if (!tableAccess.has(req.params.table)) return fail(res, 404, 'Unknown resource');
  if (!canManage(req.actor)) return fail(res, 403, 'Manager access required');
  if (req.actor.role !== 'owner' && req.params.table === 'branches') return fail(res, 403, 'Only owner can manage branches');
  return next();
}

app.get('/health', (_, res) => res.json({ ok: true }));

// This preserves the app's current username + employee-code login flow. Before public launch,
// replace it with a password or Supabase Auth; employee codes are not passwords.
app.post('/v1/auth/login', async (req, res) => {
  const { username, employeeCode } = req.body ?? {};
  if (!username || !employeeCode) return fail(res, 400, 'username and employeeCode are required');
  const { data: employee, error } = await db.from('employees').select(employeeSelect)
    .eq('username', username).eq('employee_code', employeeCode).eq('status', 'Active').maybeSingle();
  if (error) return fail(res, 500, error.message);
  if (!employee) return fail(res, 401, 'Invalid credentials');
  const role = roleFor(employee);
  const token = jwt.sign({ employee_id: employee.id, branch_id: employee.branch_id, role }, process.env.API_JWT_SECRET, { expiresIn: '8h' });
  return res.json({ employee, token });
});

app.use('/v1', authorize);

app.get('/v1/tables/:table', guardTable, async (req, res) => {
  const { table } = req.params;
  const { orderBy = 'id', branchId } = req.query;
  let query = db.from(table).select(table === 'employees' ? employeeSelect : '*').order(orderBy);
  if (branchId) query = query.eq(table === 'branches' ? 'id' : 'branch_id', branchId);
  else if (req.actor.role !== 'owner' && ['employees', 'customers', 'announcements', 'calendar_events'].includes(table)) query = query.eq('branch_id', req.actor.branch_id);
  const { data, error } = await query;
  if (error) return fail(res, 400, error.message);
  return res.json(data);
});
app.post('/v1/tables/:table', guardTable, async (req, res) => {
  const { data, error } = await db.from(req.params.table).insert(scopedData(req, req.params.table, req.body)).select().single();
  if (error) return fail(res, 400, error.message); return res.status(201).json(data);
});
app.patch('/v1/tables/:table/:id', guardTable, async (req, res) => {
  const { error } = await db.from(req.params.table).update(scopedData(req, req.params.table, req.body)).eq('id', req.params.id);
  if (error) return fail(res, 400, error.message); return res.status(204).end();
});
app.delete('/v1/tables/:table/:id', guardTable, async (req, res) => {
  const { error } = await db.from(req.params.table).delete().eq('id', req.params.id);
  if (error) return fail(res, 400, error.message); return res.status(204).end();
});

app.get('/v1/me/attendance', async (req, res) => {
  const { from, to } = req.query; let query = db.from('attendance').select().eq('employee_id', req.actor.employee_id);
  if (from) query = query.gte('work_date', from); if (to) query = query.lte('work_date', to);
  const { data, error } = await query.order('work_date'); if (error) return fail(res, 400, error.message); return res.json(data);
});
app.post('/v1/me/attendance/photo', upload.single('photo'), async (req, res) => {
  if (!req.file) return fail(res, 400, 'photo is required');
  const checkIn = req.body.checkIn === 'true'; const capturedAt = new Date(req.body.capturedAt);
  if (Number.isNaN(capturedAt.valueOf())) return fail(res, 400, 'capturedAt is invalid');
  const extension = req.file.mimetype === 'image/png' ? 'png' : 'jpg';
  const path = `attendance/${req.actor.employee_id}/${capturedAt.valueOf()}.${extension}`;
  const { error: uploadError } = await db.storage.from('attendance-photos').upload(path, req.file.buffer, { contentType: req.file.mimetype, upsert: false });
  if (uploadError) return fail(res, 400, uploadError.message);
  const { data: { publicUrl } } = db.storage.from('attendance-photos').getPublicUrl(path);
  const workDate = capturedAt.toISOString().slice(0, 10);
  const { data: existing, error: findError } = await db.from('attendance').select().eq('employee_id', req.actor.employee_id).eq('work_date', workDate).maybeSingle();
  if (findError) return fail(res, 400, findError.message);
  const values = checkIn ? { check_in: capturedAt.toISOString(), check_in_photo_url: publicUrl, status: 'Present' } : { check_out: capturedAt.toISOString(), check_out_photo_url: publicUrl };
  if (!existing && !checkIn) return fail(res, 400, 'Check in before checking out');
  const result = existing ? await db.from('attendance').update(values).eq('id', existing.id) : await db.from('attendance').insert({ ...values, employee_id: req.actor.employee_id, work_date: workDate });
  if (result.error) return fail(res, 400, result.error.message); return res.status(204).end();
});

app.use((err, _, res, __) => { console.error(err); return fail(res, 500, 'Internal server error'); });
app.listen(Number(process.env.PORT || 3000), () => console.log(`API listening on ${process.env.PORT || 3000}`));
