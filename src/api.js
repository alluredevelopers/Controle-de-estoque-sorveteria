const API_ROOT = '/api'

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.code = code
  }
}

export async function api(path, options = {}) {
  const { body, headers, ...rest } = options
  const response = await fetch(`${API_ROOT}${path}`, {
    credentials: 'same-origin',
    ...rest,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(headers || {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const contentType = response.headers.get('content-type') || ''
  const payload = contentType.includes('application/json')
    ? await response.json().catch(() => ({}))
    : await response.blob()

  if (!response.ok) {
    throw new ApiError(payload?.error || 'Não foi possível concluir a operação.', response.status, payload?.code)
  }
  return payload
}

export async function download(path, filename) {
  const blob = await api(path)
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1_000)
}

export function queryString(values) {
  const params = new URLSearchParams()
  Object.entries(values).forEach(([key, value]) => {
    if (value !== '' && value !== null && value !== undefined) params.set(key, String(value))
  })
  const string = params.toString()
  return string ? `?${string}` : ''
}
