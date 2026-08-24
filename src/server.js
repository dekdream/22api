import 'dotenv/config';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import cors from 'cors';
import express from 'express';
import jwt from 'jsonwebtoken';
import multer from 'multer';
import { db } from './postgres.js';

const required = ['DATABASE_URL', 'API_JWT_SECRET'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing ${key} in .env`);
const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const uploadDir = path.resolve(process.env.UPLOAD_DIR || './uploads');
const businessTimeZone = process.env.BUSINESS_TIME_ZONE || 'Asia/Bangkok';
const origins = (process.env.CLIENT_ORIGIN || '')
  .split(',')
  .map((x) => x.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, callback) => {
    // Allow non-browser requests and local Flutter Web development servers.
    if (!origin || origin.startsWith('http://localhost:')) {
      return callback(null, true);
    }
    return callback(null, origins.includes(origin));
  },
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
}));
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', true);
app.use('/uploads', express.static(uploadDir, { maxAge: '1d' }));

function publicFileUrl(req, relativePath) {
  const baseUrl = process.env.PUBLIC_BASE_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  return `${baseUrl}/uploads/${relativePath.split(path.sep).join('/')}`;
}

async function saveUpload(req, folder, fileName, file) {
  const relativePath = path.join(folder, fileName);
  const absolutePath = path.join(uploadDir, relativePath);
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, file.buffer);
  return publicFileUrl(req, relativePath);
}

// Resources used by the Flutter app. QR-attendance sessions are not part of
// the current schema, but departments are and must remain available.
const tableAccess = new Set([
  'branches', 'departments', 'positions', 'employees', 'customers', 'announcements',
  'payroll', 'attendance', 'services', 'service_history', 'calendar_events',
  'leave_requests', 'leave_type', 'notifications', 'commission',
  'queue_bookings',
]);
const employeeSelect = '*, positions(name, salary), branches(branch_code, branch_name)';
const tableSelect = {
  positions: '*, departments(name)',
  employees: employeeSelect,
  customers: '*, branches(branch_code, branch_name)',
  payroll: '*, employees(employee_code, first_name, last_name, branch_id, branches(branch_code, branch_name))',
  attendance: '*, employees(employee_code, first_name, last_name, branch_id, branches(branch_code, branch_name))',
  service_history: '*, services(name), employees!service_history_employee_id_fkey(first_name, last_name, employee_code, branch_id, branches(branch_name))',
  // leave_requests also has reviewed_by -> employees, so disambiguate the
  // employee relation used by employee_id.
  leave_requests: '*, leave_type(name), employees!leave_requests_employee_id_fkey(employee_code, first_name, last_name, branch_id)',
  commission: '*, employees!commission_employee_id_fkey(employee_code, first_name, last_name, branch_id)',
  queue_bookings: '*, services(name), employees!queue_bookings_employee_id_fkey(first_name, last_name, employee_code), branches(branch_name)',
};
// PostgREST only filters the parent rows through an embedded relation when
// the relation is marked `!inner`.
const branchScopedTableSelect = {
  payroll: '*, employees!inner(employee_code, first_name, last_name, branch_id, branches(branch_code, branch_name))',
  attendance: '*, employees!inner(employee_code, first_name, last_name, branch_id, branches(branch_code, branch_name))',
  service_history: '*, services(name), employees!service_history_employee_id_fkey!inner(first_name, last_name, employee_code, branch_id, branches(branch_name))',
  leave_requests: '*, leave_type(name), employees!leave_requests_employee_id_fkey!inner(employee_code, first_name, last_name, branch_id)',
  commission: '*, employees!commission_employee_id_fkey!inner(employee_code, first_name, last_name, branch_id)',
};
const directBranchTables = new Set(['customers', 'announcements', 'calendar_events', 'queue_bookings']);
const employeeBranchTables = new Set(['payroll', 'attendance', 'service_history', 'leave_requests', 'commission']);
const employeeReferencedTables = new Set([...employeeBranchTables, 'notifications']);

function fail(res, status, message) { return res.status(status).json({ error: message }); }
function selectFor(actor, table) {
  return actor.role === 'owner'
    ? (tableSelect[table] ?? '*')
    : (branchScopedTableSelect[table] ?? tableSelect[table] ?? '*');
}
function businessDate(value) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: businessTimeZone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}
function imageExtension(file) {
  if (file.mimetype === 'image/png') return 'png';
  if (file.mimetype === 'image/webp') return 'webp';
  if (file.mimetype === 'image/jpeg') return 'jpg';
  // Flutter Web may send MultipartFile.fromBytes as application/octet-stream.
  // Fall back to the uploaded filename in that case.
  const extension = String(file.originalname || '').toLowerCase().split('.').pop();
  if (extension === 'png') return 'png';
  if (extension === 'webp') return 'webp';
  if (extension === 'jpg' || extension === 'jpeg') return 'jpg';
  if (file.mimetype === 'application/octet-stream') return 'jpg';
  return null;
}
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
  if (req.actor.role === 'branchOwner' || req.actor.role === 'admin') {
    if (table === 'employees' || directBranchTables.has(table)) data.branch_id = req.actor.branch_id;
  }
  return data;
}
function guardTable(req, res, next) {
  if (!tableAccess.has(req.params.table)) {
    return fail(res, 404, 'Unknown resource');
  }

  const isOwnerOrAdmin =
    req.actor.role === 'owner' || req.actor.role === 'admin';

  if (req.params.table === 'service_history' && !isOwnerOrAdmin) {
    return fail(res, 403, 'Owner or admin access required');
  }

  if (!canManage(req.actor)) {
    return fail(res, 403, 'Manager access required');
  }

  if (
    req.actor.role !== 'owner' &&
    req.params.table === 'branches'
  ) {
    return fail(res, 403, 'Only owner can manage branches');
  }

  return next();
}

function guardTableRead(req, res, next) {
  if (!tableAccess.has(req.params.table)) {
    return fail(res, 404, 'Unknown resource');
  }
  if (canManage(req.actor)) return next();

  // Employees may read only data needed by their own portal. The query scope
  // below limits employee-linked tables to the logged-in employee/branch.
  const employeeReadable = new Set([
    'employees', 'announcements', 'payroll', 'attendance',
    'leave_requests', 'service_history', 'calendar_events', 'notifications',
    'services', 'leave_type',
  ]);
  if (req.actor.role === 'employee' && employeeReadable.has(req.params.table)) {
    return next();
  }
  return fail(res, 403, 'Access denied');
}

function applyBranchScope(query, actor, table) {
  if (actor.role === 'owner') return query;
  if (actor.role === 'employee') {
    if (employeeBranchTables.has(table)) return query.eq('employee_id', actor.employee_id);
    if (table === 'employees') return query.eq('id', actor.employee_id);
    if (directBranchTables.has(table)) return query.eq('branch_id', actor.branch_id);
    if (table === 'notifications') return query.eq('employee_id', actor.employee_id);
    return query;
  }
  if (table === 'employees') return query.eq('branch_id', actor.branch_id);
  if (directBranchTables.has(table)) return query.eq('branch_id', actor.branch_id);
  if (employeeBranchTables.has(table)) return query.eq('employees.branch_id', actor.branch_id);
  if (table === 'notifications') return query.eq('employee_id', actor.employee_id);
  return query;
}

async function canAccessRecord(actor, table, id) {
  if (actor.role === 'owner') return true;
  if (table === 'branches' || table === 'positions' || table === 'services' || table === 'leave_type') return false;
  let query = db.from(table).select(selectFor(actor, table)).eq('id', id);
  query = applyBranchScope(query, actor, table);
  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return Boolean(data);
}

async function requireRecordAccess(req, res, next) {
  try {
    if (!await canAccessRecord(req.actor, req.params.table, req.params.id)) {
      return fail(res, 404, 'Resource not found');
    }
    return next();
  } catch (error) {
    return fail(res, 400, error.message);
  }
}

async function requirePayloadScope(req, res, next) {
  if (req.actor.role === 'owner' || !employeeReferencedTables.has(req.params.table) || !req.body?.employee_id) return next();
  const { data, error } = await db.from('employees').select('id').eq('id', req.body.employee_id).eq('branch_id', req.actor.branch_id).maybeSingle();
  if (error) return fail(res, 400, error.message);
  if (!data) return fail(res, 403, 'Employee is outside your branch');
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

app.get('/v1/tables/:table', guardTableRead, async (req, res) => {
  const { table } = req.params;
  const { orderBy = 'id', branchId, workDate, workDateFrom, workDateTo } = req.query;
  let query = db.from(table).select(selectFor(req.actor, table));
  query = applyBranchScope(query, req.actor, table);
  if (table === 'attendance') {
    if (workDate) query = query.eq('work_date', workDate);
    if (workDateFrom) query = query.gte('work_date', workDateFrom);
    if (workDateTo) query = query.lte('work_date', workDateTo);
  }
  // Only the owner can choose a branch other than their own scope.
  if (branchId && req.actor.role === 'owner') {
    if (table === 'branches') query = query.eq('id', branchId);
    else if (table === 'employees' || directBranchTables.has(table)) query = query.eq('branch_id', branchId);
    else if (employeeBranchTables.has(table)) query = query.eq('employees.branch_id', branchId);
  }
  query = query.order(orderBy);
  const { data, error } = await query;
  if (error) return fail(res, 400, error.message);
  return res.json(data);
});
app.post('/v1/tables/:table', guardTable, requirePayloadScope, async (req, res) => {
  const { data, error } = await db.from(req.params.table).insert(scopedData(req, req.params.table, req.body)).select().single();
  if (error) return fail(res, 400, error.message); return res.status(201).json(data);
});
app.patch('/v1/tables/:table/:id', guardTable, requireRecordAccess, requirePayloadScope, async (req, res) => {
  const { error } = await db.from(req.params.table).update(scopedData(req, req.params.table, req.body)).eq('id', req.params.id);
  if (error) return fail(res, 400, error.message); return res.status(204).end();
});
app.delete('/v1/tables/:table/:id', guardTable, requireRecordAccess, async (req, res) => {
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
  const extension = imageExtension(req.file);
  if (!extension) return fail(res, 400, 'photo must be a JPEG, PNG, or WebP image');
  const checkIn = req.body.checkIn === 'true'; const capturedAt = new Date(req.body.capturedAt);
  if (Number.isNaN(capturedAt.valueOf())) return fail(res, 400, 'capturedAt is invalid');
  let publicUrl;
  try {
    publicUrl = await saveUpload(req, 'attendance-photos', `${req.actor.employee_id}/${capturedAt.valueOf()}-${randomUUID()}.${extension}`, req.file);
  } catch (error) {
    console.error('Attendance photo storage upload failed:', error);
    return fail(res, 500, 'Could not save attendance photo');
  }
  const workDate = businessDate(capturedAt);
  const { data: existing, error: findError } = await db.from('attendance').select().eq('employee_id', req.actor.employee_id).eq('work_date', workDate).maybeSingle();
  if (findError) return fail(res, 400, findError.message);
  const values = checkIn ? { check_in: capturedAt.toISOString(), check_in_photo_url: publicUrl, status: 'Present' } : { check_out: capturedAt.toISOString(), check_out_photo_url: publicUrl };
  if (!existing && !checkIn) return fail(res, 400, 'Check in before checking out');
  const result = existing ? await db.from('attendance').update(values).eq('id', existing.id) : await db.from('attendance').insert({ ...values, employee_id: req.actor.employee_id, work_date: workDate });
  if (result.error) return fail(res, 400, result.error.message); return res.status(204).end();
});

async function saveProfilePhoto(req, res, employeeId) {
  const photo = req.file ?? (Array.isArray(req.files) ? req.files[0] : null);
  if (!photo) return fail(res, 400, 'photo is required');
  const extension = imageExtension(photo);
  if (!extension) return fail(res, 400, 'photo must be a JPEG, PNG, or WebP image');
  let publicUrl;
  try {
    publicUrl = await saveUpload(req, 'profile', `${employeeId}/${Date.now()}-${randomUUID()}.${extension}`, photo);
  } catch (error) {
    console.error('Profile photo storage upload failed:', error);
    return fail(res, 500, 'Could not save profile photo');
  }
  const { error } = await db.from('employees').update({ profile_image: publicUrl }).eq('id', employeeId);
  if (error) {
    console.error('Profile photo database update failed:', error);
    return fail(res, 400, error.message);
  }
  return res.json({ profile_image: publicUrl });
}

// Employees may update their own profile photo.
app.post('/v1/me/profile-photo', upload.any(), async (req, res) =>
  saveProfilePhoto(req, res, req.actor.employee_id));

// Owner/admin may update a selected employee's profile photo from management.
app.post('/v1/employees/:id/profile-photo', upload.any(), async (req, res) => {
  if (!canManage(req.actor)) return fail(res, 403, 'Manager access required');
  return saveProfilePhoto(req, res, req.params.id);
});

app.use((err, _, res, __) => { console.error(err); return fail(res, 500, 'Internal server error'); });
app.listen(Number(process.env.PORT || 3000), () => console.log(`API listening on ${process.env.PORT || 3000}`));
