export const IS_DEV = import.meta.env.DEV;
export const API_BASE = import.meta.env.VITE_API_BASE || '';

/**
 * Call the v2 backend. Sends the SSO payload header so the backend can identify the
 * location. Throws an Error carrying .status / .code / .details from the JSON body.
 */
async function call(method, path, ssoPayload, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-SSO-Payload': ssoPayload || '',
      'ngrok-skip-browser-warning': 'true',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  let data = null;
  try {
    data = await res.json();
  } catch {
    // non-JSON response
  }

  if (!res.ok || (data && data.success === false)) {
    const err = new Error(data?.error || data?.message || `Request failed (${res.status})`);
    err.status = res.status;
    err.code = data?.code;
    err.details = data?.details;
    throw err;
  }
  return data?.data ?? data;
}

export const api = { call };
