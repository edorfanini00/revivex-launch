// Vercel function: the email waitlist is closed.
// The previous handler logged raw email addresses and reported "saved" without any
// durable store. Until an approved store, notice and unsubscribe process exist, this
// route refuses every submission, logs nothing and never reports success.
export default function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  if (req.method !== 'POST') {
    res.statusCode = 405;
    res.setHeader('Allow', 'POST');
    return res.end(JSON.stringify({ ok: false, message: 'Method not allowed' }));
  }
  res.statusCode = 503;
  return res.end(JSON.stringify({ ok: false, message: 'Email signup is not open yet. Nothing was saved.' }));
}
