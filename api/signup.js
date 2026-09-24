// Vercel serverless function — stores signups in Vercel KV or logs to console
// For early access, we just return success (emails collected via form service)
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'POST');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, message: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    const email = (body?.email || '').trim().toLowerCase();
    const consent = body?.consent;
    const honeypot = body?.website;

    if (honeypot) return res.status(400).json({ ok: false, message: 'Unable to save.' });
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ ok: false, message: 'Enter a valid email address.' });
    }
    if (!consent) {
      return res.status(400).json({ ok: false, message: 'Please agree to receive updates.' });
    }

    // Log to Vercel logs (visible in dashboard) + return success
    console.log(JSON.stringify({ event: 'signup', email, ts: new Date().toISOString() }));

    return res.status(200).json({
      ok: true,
      message: 'Your interest is saved. Thank you for being here at the beginning.'
    });
  } catch (e) {
    return res.status(500).json({ ok: false, message: 'Something went wrong.' });
  }
}
