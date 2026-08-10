/**
 * Civitai tRPC wire helpers.
 *
 * Civitai currently serves both its legacy `{ result.data.json }` envelope and
 * a newer string-encoded reference table. Keep the decoding in one tested
 * place so an upstream serializer migration cannot silently look like an empty
 * account.
 */

export function decodeReferenceTable(table) {
  if (!Array.isArray(table) || table.length === 0) return table;

  const decoded = new Map();

  function decode(index) {
    if (!Number.isInteger(index)) return index;
    if (index < 0) return null; // JavaScript-only/special values are not stats data.
    if (index >= table.length) {
      throw new Error(`tRPC reference ${index} is outside a table of ${table.length} entries`);
    }
    if (decoded.has(index)) return decoded.get(index);

    const value = table[index];
    if (Array.isArray(value)) {
      const result = [];
      decoded.set(index, result);
      for (const item of value) {
        result.push(Number.isInteger(item) ? decode(item) : item);
      }
      return result;
    }
    if (value && typeof value === 'object') {
      const result = {};
      decoded.set(index, result);
      for (const [key, item] of Object.entries(value)) {
        result[key] = Number.isInteger(item) ? decode(item) : item;
      }
      return result;
    }

    decoded.set(index, value);
    return value;
  }

  return decode(0);
}

export function extractTrpcPayload(body) {
  // Non-batched calls are expected, but accepting a single batched response
  // makes the decoder resilient to a harmless server-side envelope change.
  if (Array.isArray(body) && body.length === 1 && body[0]?.result) {
    return extractTrpcPayload(body[0]);
  }

  if (body?.error) {
    const message = body.error?.json?.message || body.error?.message || 'tRPC returned an error payload';
    throw new Error(message);
  }

  const payload = body?.result?.data;
  if (typeof payload === 'string') {
    let parsed;
    try {
      parsed = JSON.parse(payload);
    } catch (error) {
      throw new Error(`Could not parse string-encoded tRPC payload: ${error.message}`);
    }
    return Array.isArray(parsed) ? decodeReferenceTable(parsed) : parsed;
  }
  if (payload && typeof payload === 'object' && 'json' in payload) {
    return payload.json;
  }
  return payload;
}

export function createTrpcHeaders(origin, token = null) {
  const normalizedOrigin = new URL(origin).origin;
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Accept': 'application/json',
    'Referer': `${normalizedOrigin}/`,
    'Origin': normalizedOrigin
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}
