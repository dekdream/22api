import pg from 'pg';

const { Pool } = pg;
const tableNames = new Set([
  'branches', 'departments', 'positions', 'employees', 'customers', 'announcements',
  'payroll', 'attendance', 'services', 'service_history', 'calendar_events',
  'leave_requests', 'leave_type', 'notifications', 'commission', 'queue_bookings','branch_transactions',
]);

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
});

function normalizeMediaUrl(value) {
  if (typeof value !== 'string' || !value.startsWith('http')) return value;
  const endpoint = (process.env.S3_ENDPOINT || process.env.AWS_ENDPOINT_URL || process.env.AWS_S3_ENDPOINT || 'https://t3.storageapi.dev').replace(/\/$/, '');
  const bucket = process.env.S3_BUCKET_NAME || process.env.S3_BUCKET || process.env.AWS_BUCKET_NAME || process.env.AWS_S3_BUCKET_NAME || process.env.AWS_S3_BUCKET || process.env.BUCKET_NAME;
  const publicBase = (process.env.PUBLIC_BASE_URL || 'https://22api-production.up.railway.app').replace(/\/$/, '');
  const prefix = bucket ? `${endpoint}/${bucket}/` : '';
  return publicBase && prefix && value.startsWith(prefix) ? `${publicBase}/uploads/${value.slice(prefix.length)}` : value;
}

function identifier(value) {
  if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(value)) {
    throw new Error('Invalid database identifier');
  }
  return value;
}

function condition(column, operator, value, params) {
  const safeColumn = identifier(column);
  if (safeColumn.includes('.')) {
    const [relation, field] = safeColumn.split('.');
    if (relation !== 'employees') throw new Error('Unsupported relation filter');
    params.push(value);
    return `EXISTS (SELECT 1 FROM employees scope_employee WHERE scope_employee.id = t.employee_id AND scope_employee.${field} ${operator} $${params.length})`;
  }
  params.push(value);
  return `t.${safeColumn} ${operator} $${params.length}`;
}

async function decorate(table, row) {
  const result = Object.fromEntries(Object.entries(row).map(([key, value]) => [key, key === 'profile_image' || key.endsWith('_photo_url') ? normalizeMediaUrl(value) : value]));
  const employeeId = row.employee_id;
  if (table === 'employees' || employeeId) {
    const id = table === 'employees' ? row.id : employeeId;
    if (id) {
      const employee = await pool.query(
        'SELECT e.*, p.name AS position_name, p.salary AS position_salary, b.branch_code, b.branch_name FROM employees e LEFT JOIN positions p ON p.id = e.position_id LEFT JOIN branches b ON b.id = e.branch_id WHERE e.id = $1',
        [id],
      );
      if (employee.rows[0]) {
        const linked = employee.rows[0];
        const nestedEmployee = { ...linked, positions: linked.position_name ? { name: linked.position_name, salary: linked.position_salary } : null, branches: linked.branch_name ? { branch_code: linked.branch_code, branch_name: linked.branch_name } : null };
        delete nestedEmployee.position_name;
        delete nestedEmployee.position_salary;
        delete nestedEmployee.branch_code;
        delete nestedEmployee.branch_name;
        if (table === 'employees') return nestedEmployee;
        result.employees = nestedEmployee;
      }
    }
  }
  if (table === 'positions' && row.department_id) {
    const department = await pool.query('SELECT name FROM departments WHERE id = $1', [row.department_id]);
    if (department.rows[0]) result.departments = department.rows[0];
  }
  if (table === 'customers' || table === 'queue_bookings') {
    const branchId = row.branch_id;
    if (branchId) {
      const branch = await pool.query('SELECT branch_code, branch_name FROM branches WHERE id = $1', [branchId]);
      if (branch.rows[0]) result.branches = branch.rows[0];
    }
  }
  if (table === 'leave_requests' && row.leave_type_id) {
    const leaveType = await pool.query('SELECT name FROM leave_type WHERE id = $1', [row.leave_type_id]);
    if (leaveType.rows[0]) result.leave_type = leaveType.rows[0];
  }
  if ((table === 'service_history' || table === 'queue_bookings') && row.service_id) {
    const service = await pool.query('SELECT name FROM services WHERE id = $1', [row.service_id]);
    if (service.rows[0]) result.services = service.rows[0];
  }
  return result;
}

class QueryBuilder {
  constructor(table) {
    if (!tableNames.has(table)) throw new Error('Unknown resource');
    this.table = table;
    this.operation = 'select';
    this.filters = [];
    this.params = [];
    this.returning = false;
    this.singleResult = false;
  }

  select() { this.returning = true; return this; }
  eq(column, value) { this.filters.push(condition(column, '=', value, this.params)); return this; }
  gte(column, value) { this.filters.push(condition(column, '>=', value, this.params)); return this; }
  lte(column, value) { this.filters.push(condition(column, '<=', value, this.params)); return this; }
  order(column) { this.orderBy = identifier(column); return this; }
  maybeSingle() { this.singleResult = true; return this; }
  single() { this.singleResult = true; return this; }
  insert(data) { this.operation = 'insert'; this.data = data; return this; }
  update(data) { this.operation = 'update'; this.data = data; return this; }
  delete() { this.operation = 'delete'; return this; }

  async execute() {
    try {
      let result;
      if (this.operation === 'select') {
        const where = this.filters.length ? ` WHERE ${this.filters.join(' AND ')}` : '';
        const order = this.orderBy ? ` ORDER BY t.${this.orderBy}` : '';
        result = await pool.query(`SELECT t.* FROM ${this.table} t${where}${order}`, this.params);
        const data = await Promise.all(result.rows.map((row) => decorate(this.table, row)));
        return { data: this.singleResult ? (data[0] ?? null) : data, error: null };
      }
      const keys = Object.keys(this.data ?? {});
      const values = keys.map((key) => this.data[key]);
      if (!keys.length && this.operation !== 'delete') throw new Error('Request body is empty');
      if (this.operation === 'insert') {
        const columns = keys.map(identifier).join(', ');
        const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
        result = await pool.query(`INSERT INTO ${this.table} (${columns}) VALUES (${placeholders}) RETURNING *`, values);
      } else if (this.operation === 'update') {
        const assignments = keys.map((key, index) => `${identifier(key)} = $${index + 1}`).join(', ');
            const where = this.filters.length
              ? ` WHERE ${this.filters.join(' AND ').replace(/\$(\d+)/g, (_, index) => `$${Number(index) + keys.length}`)}`
              : '';
        result = await pool.query(`UPDATE ${this.table} t SET ${assignments}${where} RETURNING *`, [...values, ...this.params]);
      } else {
        const where = this.filters.length ? ` WHERE ${this.filters.join(' AND ')}` : '';
        result = await pool.query(`DELETE FROM ${this.table} t${where} RETURNING *`, this.params);
      }
      const data = await Promise.all(result.rows.map((row) => decorate(this.table, row)));
      return { data: this.singleResult ? (data[0] ?? null) : data, error: null, count: result.rowCount };
    } catch (error) {
      return { data: null, error };
    }
  }

  then(resolve, reject) { return this.execute().then(resolve, reject); }
}

export const db = { from: (table) => new QueryBuilder(table), pool };
