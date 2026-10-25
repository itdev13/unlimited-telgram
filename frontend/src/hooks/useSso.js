import { useCallback, useEffect, useState } from 'react';
import { API_BASE, IS_DEV } from '../api';

export default function useSso() {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [ssoPayload, setSsoPayload] = useState(null);

  const decryptPayload = useCallback(async (encryptedPayload) => {
    try {
      const res = await fetch(`${API_BASE}/auth/sso/decrypt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'ngrok-skip-browser-warning': 'true' },
        body: JSON.stringify({ payload: encryptedPayload }),
      });
      if (!res.ok) throw new Error('SSO decryption failed');
      const data = await res.json();
      if (!data.success || !data.data.locationId) {
        throw new Error('Please open this page from a sub-account.');
      }
      setUser(data.data);
      setSsoPayload(encryptedPayload);
    } catch (err) {
      setError(err.message || 'SSO authentication failed');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (IS_DEV) {
      const t = setTimeout(() => {
        setUser({
          userId: 'dev_user',
          companyId: 'dev_company',
          locationId: 'dev_location',
          userName: 'Dev User',
          email: 'dev@example.com',
          role: 'admin',
        });
        setSsoPayload('dev-mock-payload');
        setLoading(false);
      }, 700);
      return () => clearTimeout(t);
    }

    let timeout;
    const handleMessage = (event) => {
      if (event.data?.message === 'REQUEST_USER_DATA_RESPONSE') {
        clearTimeout(timeout);
        decryptPayload(event.data.payload);
      }
    };
    window.addEventListener('message', handleMessage);
    window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*');
    timeout = setTimeout(() => {
      setLoading(false);
      setError('Could not connect. Please refresh the page.');
    }, 10000);

    return () => {
      window.removeEventListener('message', handleMessage);
      clearTimeout(timeout);
    };
  }, [decryptPayload]);

  return { user, loading, error, ssoPayload };
}
