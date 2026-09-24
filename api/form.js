// /api/form — returns a CSRF token (simplified for Vercel, stateless)
import crypto from 'crypto';

export default function handler(req, res) {
  const token = crypto.randomBytes(32).toString('base64url');
  return res.status(200).json({ token });
}
