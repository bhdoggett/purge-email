import { apiRequest } from "./tauri.ts";

/** A fetch() that sends the request through Rust, which attaches credentials. */
export async function proxyFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const headers: [string, string][] = [];
  new Headers(init.headers).forEach((value, key) => headers.push([key, value]));
  const body = init.body == null ? null : typeof init.body === "string" ? init.body : await new Response(init.body).text();
  const res = await apiRequest({ url: input, method: init.method ?? "GET", headers, body });
  // Response forbids a body on these statuses.
  const nullBody = res.status === 204 || res.status === 304;
  return new Response(nullBody ? null : res.body, { status: res.status, headers: res.headers });
}
