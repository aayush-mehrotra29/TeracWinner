# TeracWinner

An auth-only Next.js and React site for TeracWinner. It currently supports email sign-in, account creation, password recovery, Google sign-in, session persistence, and sign-out. The right panel is an animated Canvas2D hatch effect generated from the procedural smoke palette; it does not use a photo or video.

## Run locally

Use Node.js 20.9 or newer.

```bash
npm ci
cp .env.example .env.local
npm run dev
```

Set `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` in `.env.local` to the new Supabase project's public API values. Never put a database password, Google OAuth client secret, or Supabase secret/service-role key in a `NEXT_PUBLIC_` variable or commit it to Git.

Open [http://localhost:3000](http://localhost:3000). The application is intentionally only an authentication page for now.

## Auth configuration

In Supabase **Authentication → URL Configuration**, set the local Site URL to `http://localhost:3000` and allow `http://localhost:3000/auth/callback**` as a redirect URL. Add the deployed site's exact HTTPS callback URL when deploying. The callback handles both Google OAuth and password recovery.

To enable Google, create a Google Cloud OAuth **Web application** client. Add `http://localhost:3000` as an authorized JavaScript origin and `https://<supabase-project-ref>.supabase.co/auth/v1/callback` as an authorized redirect URI. Enter that client's ID and secret in Supabase **Authentication → Providers → Google**. Keep the secret in the provider configuration, never in this repository.

## Checks

```bash
npm run typecheck
npm run lint
npm run build
```
