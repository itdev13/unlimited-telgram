const { Router } = require('express');
const path = require('path');
const fs = require('fs');
const rateLimit = require('express-rate-limit');
const { MEDIA_DIR, MEDIA_MAX_AGE_MS, mimeFromExt } = require('./media-store');

function createMediaRouter() {
  const router = Router();

  // Rate limiting to prevent abuse
  const mediaLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 200,
    standardHeaders: true,
    legacyHeaders: false,
  });
  router.use(mediaLimiter);

  // GET /media/:filename — serves temporary media files. Supports HTTP Range so audio
  // and video play inline (players request partial content; without Range support many
  // clients refuse to play or show a non-functional player).
  router.get('/:filename', (req, res) => {
    const { filename } = req.params;

    // Sanitize filename to prevent path traversal. Never serve the .meta sidecar itself.
    const sanitized = path.basename(filename);
    if (sanitized.endsWith('.meta')) {
      return res.status(404).json({ error: 'File not found' });
    }
    const filePath = path.join(MEDIA_DIR, sanitized);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ error: 'File not found or expired' });
    }

    // Content-Type: prefer the stored sidecar (accurate for voice notes / opus / odd
    // extensions), fall back to extension-based detection.
    let contentType = mimeFromExt(path.extname(sanitized));
    try {
      const meta = fs.readFileSync(`${filePath}.meta`, 'utf8').trim();
      if (meta) contentType = meta;
    } catch {
      // no sidecar — keep the extension-derived type
    }

    const stat = fs.statSync(filePath);
    const total = stat.size;

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');

    const range = req.headers.range;
    if (range) {
      const match = /bytes=(\d*)-(\d*)/.exec(range);
      const start = match && match[1] ? parseInt(match[1], 10) : 0;
      const end = match && match[2] ? parseInt(match[2], 10) : total - 1;
      if (start >= total || end >= total || start > end) {
        res.setHeader('Content-Range', `bytes */${total}`);
        return res.status(416).end();
      }
      res.status(206);
      res.setHeader('Content-Range', `bytes ${start}-${end}/${total}`);
      res.setHeader('Content-Length', end - start + 1);
      return fs.createReadStream(filePath, { start, end }).pipe(res);
    }

    res.setHeader('Content-Length', total);
    fs.createReadStream(filePath).pipe(res);
  });

  return router;
}

// Clean up expired media files (called on startup and every 30 minutes)
function cleanupExpiredMedia() {
  if (!fs.existsSync(MEDIA_DIR)) return;

  const now = Date.now();
  try {
    const files = fs.readdirSync(MEDIA_DIR);
    for (const file of files) {
      const filePath = path.join(MEDIA_DIR, file);
      const stat = fs.statSync(filePath);
      if (now - stat.mtimeMs > MEDIA_MAX_AGE_MS) {
        fs.unlinkSync(filePath); // removes both media files and their .meta sidecars
      }
    }
  } catch (err) {
    console.warn('Media cleanup error:', err.message);
  }
}

module.exports = { createMediaRouter, cleanupExpiredMedia };
