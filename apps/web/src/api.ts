export class ApiError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export async function api<T>(endpoint: string, body: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch(`/api${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
    body: JSON.stringify(body), signal, cache: 'no-store',
  });
  const result = await response.json().catch(() => null);
  if (!response.ok || result === null) {
    const detail = result?.detail;
    const message = typeof detail === 'string' ? detail : Array.isArray(detail)
      ? detail.map(item => item.msg).filter(Boolean).join('；') : detail?.message;
    throw new ApiError(message || '充值服务暂不可用，请稍后重试。', detail?.code);
  }
  return result;
}

export function errorText(error: unknown) {
  return error instanceof ApiError ? error.message : '无法连接充值服务，请稍后重试。';
}
