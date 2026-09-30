// Client helpers for the /ai/agents pages: JSON calls to /api/ai/agents/*
// that throw an Error whose message is the API's English error key.

export async function agentsApi<T>(url: string, init?: { method: string; body?: unknown }): Promise<T> {
  const res = await fetch(url, {
    method: init?.method ?? 'GET',
    cache: 'no-store',
    headers: init?.body !== undefined ? { 'content-type': 'application/json' } : undefined,
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const body = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) {
    const err = new Error(
      res.status === 429 ? 'Too many requests. Wait a minute and try again.' : (body?.error ?? 'Something went wrong. Try again.'),
    ) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}
