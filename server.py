"""Local-only preview: SQLite storage, no email sends or external uploads."""
import json, os, re, sqlite3, time, threading, secrets
from collections import defaultdict, deque
from datetime import datetime, timezone
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit
ROOT=Path(__file__).resolve().parent
DB=Path(os.environ.get('REVIVEX_DB',ROOT/'data/signups.sqlite3'))
PORT=int(os.environ.get('PORT','4178'))

def init_db(path):
    path.parent.mkdir(parents=True,exist_ok=True)
    with sqlite3.connect(path) as c:
        c.execute('CREATE TABLE IF NOT EXISTS signups(email TEXT PRIMARY KEY, consent INTEGER NOT NULL, consented_at TEXT NOT NULL, source TEXT NOT NULL)')
    os.chmod(path,0o600)

def save_signup(path,data):
    email=data.get('email')
    if not isinstance(email,str) or len(email)>254 or not re.fullmatch(r'[A-Za-z0-9.!#$%&\'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z]{2,63}',email.strip()) or '..' in email:
        return 400,{'ok':False,'message':'Enter a valid email address.'}
    if data.get('consent') is not True:
        return 400,{'ok':False,'message':'Please agree to receive Revivex appliance updates.'}
    if data.get('website'):
        return 400,{'ok':False,'message':'Unable to save this request.'}
    with sqlite3.connect(path,timeout=10) as c:
        cursor=c.execute('INSERT OR IGNORE INTO signups VALUES(?,?,?,?)',(email.strip().lower(),1,datetime.now(timezone.utc).isoformat(),'appliance-early-release'))
    # Identical response text avoids disclosing whether an address is registered.
    return (201 if cursor.rowcount else 200),{'ok':True,'message':'Your interest is saved. Thank you for being here at the beginning.'}

class Handler(SimpleHTTPRequestHandler):
    tokens={}; attempts=defaultdict(deque); lock=threading.Lock()
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(ROOT/'public'),**kwargs)
    def log_message(self,*args): pass # Do not log addresses or request payloads.
    def end_headers(self):
        self.send_header('X-Content-Type-Options','nosniff')
        self.send_header('Referrer-Policy','no-referrer')
        self.send_header('Content-Security-Policy',"default-src 'self'; style-src 'self'; script-src 'self'; img-src 'self' data:; font-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; form-action 'self'; base-uri 'none'")
        super().end_headers()
    def reply(self,status,data):
        body=json.dumps(data).encode(); self.send_response(status)
        self.send_header('Content-Type','application/json'); self.send_header('Cache-Control','no-store'); self.send_header('Content-Length',str(len(body))); self.end_headers(); self.wfile.write(body)
    def do_GET(self):
        path=urlsplit(self.path).path
        if path=='/api/health': return self.reply(200,{'ok':True,'pid':os.getpid(),'mode':'local-preview'})
        if path=='/api/form':
            now=time.monotonic()
            with self.lock:
                self.tokens={k:v for k,v in self.tokens.items() if now-v<1800}
                if len(self.tokens)>2000: return self.reply(429,{'ok':False,'message':'Please try again later.'})
                token=secrets.token_urlsafe(32); self.tokens[token]=now
                Handler.tokens=self.tokens
            return self.reply(200,{'token':token})
        if path=='/privacy': self.path='/privacy.html'
        # Explicit static allowlist prevents accidental database/source serving.
        if path not in ('/','/index.html','/privacy','/privacy.html','/styles.css','/app.js','/favicon.svg','/robots.txt') and not path.startswith('/assets/'):
            return self.reply(404,{'ok':False})
        return super().do_GET()
    def do_POST(self):
        if self.path!='/api/signup': return self.reply(404,{'ok':False})
        origin=self.headers.get('Origin')
        if origin!=f'http://127.0.0.1:{PORT}': return self.reply(403,{'ok':False,'message':'Please use the local preview form.'})
        if self.headers.get('Content-Type','').split(';')[0]!='application/json': return self.reply(415,{'ok':False,'message':'Expected JSON.'})
        try:
            length=int(self.headers.get('Content-Length','0'))
            if length<=0 or length>4096: return self.reply(413,{'ok':False,'message':'Request is too large.'})
            data=json.loads(self.rfile.read(length))
            if not isinstance(data,dict): raise ValueError()
        except (ValueError,TypeError): return self.reply(400,{'ok':False,'message':'Invalid request.'})
        now=time.monotonic()
        with self.lock:
            q=self.attempts[self.client_address[0]]
            while q and now-q[0]>60: q.popleft()
            if len(q)>=8: return self.reply(429,{'ok':False,'message':'Please wait a minute before trying again.'})
            q.append(now)
            token=data.get('token')
            issued=self.tokens.get(token) if isinstance(token,str) else None
            if issued is None or now-issued<1 or now-issued>1800:
                return self.reply(400,{'ok':False,'message':'Please wait a moment, or reload the form and try again.'})
            self.tokens.pop(token,None)
        try: status,result=save_signup(DB,data)
        except sqlite3.Error: return self.reply(503,{'ok':False,'message':'Your interest could not be saved. Please try again.'})
        return self.reply(status,result)

if __name__=='__main__':
    init_db(DB)
    server=ThreadingHTTPServer(('127.0.0.1',PORT),Handler)
    print(f'Revivex preview http://127.0.0.1:{PORT} PID {os.getpid()}',flush=True)
    server.serve_forever()
