export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

/** Minimal client for the Shablon templates API. */
export class ShablonClient {
  /**
   * @param {{ apiKey: string, apiUrl?: string, fetch?: typeof fetch }} options
   */
  constructor({ apiKey, apiUrl = 'https://api.shablon.eu', fetch: fetchImpl = globalThis.fetch }) {
    this.apiKey = apiKey;
    this.apiUrl = apiUrl.replace(/\/+$/, '');
    this.fetch = fetchImpl;
  }

  async request(method, path, body) {
    const url = `${this.apiUrl}${path}`;
    let res;
    try {
      res = await this.fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          accept: 'application/json',
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      const cause = err.cause?.code ?? err.cause?.message;
      throw new ApiError(`${method} ${url} failed: ${err.message}${cause ? ` (${cause})` : ''}`);
    }

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : undefined;
    } catch {
      data = text;
    }

    if (!res.ok) {
      throw new ApiError(`${method} ${path} returned ${res.status}: ${formatErrorBody(res.status, data)}`, {
        status: res.status,
        body: data,
      });
    }
    return data;
  }

  /**
   * Find all templates (snippets and non-snippets) with the given slug.
   * @param {string} slug
   */
  async findBySlug(slug) {
    const found = [];
    // The list endpoint only returns non-snippets unless asked, so query both.
    for (const snippet of ['false', 'true']) {
      let cursor;
      do {
        const params = new URLSearchParams({ slug, snippet, limit: '100' });
        if (cursor) params.set('cursor', cursor);
        const page = await this.request('GET', `/v1/templates?${params}`);
        found.push(...(page?.data ?? []));
        cursor = page?.isDone ? undefined : page?.nextCursor ?? undefined;
      } while (cursor);
    }
    // Guard against the server ignoring the filter.
    return found.filter((t) => t.slug === slug);
  }

  getTemplate(id) {
    return this.request('GET', `/v1/templates/${encodeURIComponent(id)}`);
  }

  createTemplate(body) {
    return this.request('POST', '/v1/templates', body);
  }

  updateTemplate(id, body) {
    return this.request('PATCH', `/v1/templates/${encodeURIComponent(id)}`, body);
  }
}

export function formatErrorBody(status, data) {
  if (status === 401 || status === 403) {
    return 'missing or invalid API key (check the `apiKey` input / secret).';
  }
  if (data && typeof data === 'object') {
    if (Array.isArray(data.issues) && data.issues.length > 0) {
      const issues = data.issues
        .map((i) => `${Array.isArray(i.path) && i.path.length ? i.path.join('.') : '(body)'}: ${i.message}`)
        .join('; ');
      return `${data.reason ?? 'validation failed'} — ${issues}`;
    }
    return data.reason ?? data.error ?? data.message ?? JSON.stringify(data);
  }
  return typeof data === 'string' && data ? data.slice(0, 500) : 'no response body';
}
