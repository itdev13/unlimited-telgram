const express = require('express');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs');
const { formatError } = require('../utils/format-error');

// Multer for support attachments (images only, 5MB each, max 5).
const upload = multer({
  dest: 'uploads/support/',
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/jpg', 'image/png', 'image/gif', 'image/webp'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Only images are allowed (JPEG, PNG, GIF, WebP)'));
  },
});

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function createSupportRouter(ssoMiddleware) {
  const router = express.Router();

  const supportTo = process.env.SUPPORT_EMAIL_TO || 'support@vaultsuite.store';

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: process.env.SUPPORT_EMAIL_USER,
      pass: process.env.SUPPORT_EMAIL_PASSWORD,
    },
    tls: { rejectUnauthorized: false },
  });

  transporter.verify((error) => {
    if (error) {
      console.warn(`⚠️  Support email not configured: ${error.message} — tickets will fail until set.`);
    } else {
      console.log('✅ Support email service ready');
    }
  });

  // POST /support/ticket — submit a support ticket by email.
  router.post('/ticket', ssoMiddleware, upload.array('images', 5), async (req, res) => {
    try {
      const { name, email, subject, message, locationId, userId } = req.body;

      if (!email || !subject || !message) {
        return res.status(400).json({ success: false, error: 'Email, subject, and message are required' });
      }
      if (!isValidEmail(email)) {
        return res.status(400).json({ success: false, error: 'Invalid email format' });
      }

      console.log(`Support ticket received from ${escapeHtml(email)} (${locationId || '-'})`);

      const emailHtml = `
        <h2>New Support Ticket — Telegram Connector</h2>
        <hr/>
        <p><strong>From:</strong> ${escapeHtml(name || 'Not provided')}</p>
        <p><strong>Email:</strong> ${escapeHtml(email)}</p>
        <p><strong>Subject:</strong> ${escapeHtml(subject)}</p>
        <p><strong>Location ID:</strong> ${escapeHtml(locationId || 'Not provided')}</p>
        <p><strong>User ID:</strong> ${escapeHtml(userId || 'Not provided')}</p>
        <hr/>
        <h3>Message:</h3>
        <p>${escapeHtml(message).replace(/\n/g, '<br/>')}</p>
        ${req.files && req.files.length > 0 ? `<hr/><p><strong>Attachments:</strong> ${req.files.length} image(s) attached</p>` : ''}
      `;

      const attachments = req.files
        ? req.files.map((file) => ({ filename: file.originalname, path: file.path }))
        : [];

      await transporter.sendMail({
        from: email,
        to: supportTo,
        subject: `[Telegram Connector Support] ${subject}`,
        html: emailHtml,
        attachments,
      });

      if (req.files) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      }

      console.log(`✅ Support ticket sent (${escapeHtml(email)})`);
      res.json({ success: true, message: 'Support ticket submitted. We’ll get back to you soon!' });
    } catch (error) {
      console.error(`Support ticket error | ${formatError(error)}`);
      if (req.files) {
        req.files.forEach((file) => {
          if (fs.existsSync(file.path)) fs.unlinkSync(file.path);
        });
      }
      res.status(500).json({ success: false, error: 'Failed to submit support ticket', message: error.message });
    }
  });

  return router;
}

module.exports = { createSupportRouter };
