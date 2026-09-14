/**
 * Supabase URL as seen from the SERVER (route handlers, middleware, admin
 * clients). Browsers always use `NEXT_PUBLIC_SUPABASE_URL`; when the app
 * runs in a container the same address may not be routable from inside
 * (e.g. the host's LAN IP on Docker Desktop), so `SUPABASE_INTERNAL_URL`
 * lets the server reach Supabase through another route
 * (`http://host.docker.internal:56021`, or Kong's service name on a VPS).
 *
 * Server code never builds public storage URLs from this client, so the
 * internal host never leaks into stored data.
 */
export function supabaseServerUrl(): string {
  return (
    process.env.SUPABASE_INTERNAL_URL?.replace(/\/+$/, '') ||
    process.env.NEXT_PUBLIC_SUPABASE_URL!
  )
}
