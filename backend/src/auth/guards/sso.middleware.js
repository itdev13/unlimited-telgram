function createSsoMiddleware(authService) {
  return function ssoMiddleware(req, res, next) {
    const ssoPayload = req.headers['x-sso-payload'];

    if (!ssoPayload) {
      return res.status(401).json({ error: 'Missing SSO payload header' });
    }

    try {
      const userData = authService.decryptSsoPayload(ssoPayload);

      if (!userData.activeLocation) {
        return res.status(401).json({
          error: 'SSO session has no active location. Please open from a sub-account.',
        });
      }

      // Attach decoded identity to request for downstream use
      req.ssoUser = userData;
      req.locationId = userData.activeLocation;

      // Verify the locationId in the URL matches the SSO session
      const paramLocationId = req.params?.locationId;
      if (paramLocationId && paramLocationId !== userData.activeLocation) {
        return res.status(401).json({ error: 'Location ID mismatch with SSO session' });
      }

      next();
    } catch (error) {
      if (error.statusCode === 401) {
        return res.status(401).json({ error: error.message });
      }
      return res.status(401).json({ error: 'Invalid or expired SSO session' });
    }
  };
}

module.exports = { createSsoMiddleware };
