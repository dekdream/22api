# TwentyTwo API

1. Copy `.env.example` to `.env` and set `DATABASE_URL` to the Railway PostgreSQL connection string.
2. Run `npm install` inside this directory, then `npm run dev`.
3. Build Flutter with `--dart-define=API_BASE_URL=http://localhost:3000`.

The service-role key never goes to Flutter. Requests must use the JWT returned by `POST /v1/auth/login`.

## Current app data contract

The API exposes the tables still used by the app: branches, positions,
employees, customers, attendance, leave types/requests, payroll, services,
service history, commission, announcements, calendar events, notifications,
and queue bookings. Management clients use `/v1/tables/:table`; an owner can
select any branch, while a branch owner/administrator is automatically limited
to their assigned branch for reads, writes, updates, and deletes.

Employee self-service endpoints are `/v1/me/attendance`,
`/v1/me/attendance/photo`, and `/v1/me/profile-photo`. Attendance dates use
`BUSINESS_TIME_ZONE` (default `Asia/Bangkok`) instead of the API host timezone.

Retired data is deliberately not exposed: `departments` (access is now based
on position) and QR-attendance sessions (photo attendance replaced them).

`POST /v1/auth/login` retains the legacy username + employee-code login temporarily. It must be replaced with a real password login before exposing the API publicly.

Railway PostgreSQL replaces Supabase Database. Photo files are uploaded to the `enclosed-cup` S3-compatible storage. Add its credentials to the `22api` service as `S3_ENDPOINT`, `S3_REGION`, `S3_BUCKET_NAME`, `S3_ACCESS_KEY_ID`, and `S3_SECRET_ACCESS_KEY`.
