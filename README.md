# TwentyTwo API

1. Copy `.env.example` to `.env` and provide the Supabase **service-role** key.
2. Run `npm install` inside this directory, then `npm run dev`.
3. Build Flutter with `--dart-define=API_BASE_URL=http://localhost:3000`.

The service-role key never goes to Flutter. Requests must use the JWT returned by `POST /v1/auth/login`.

`POST /v1/auth/login` retains the legacy username + employee-code login temporarily. It must be replaced with a real password or Supabase Auth before exposing the API publicly.
