import unittest, subprocess, os, tempfile, time, json, urllib.request, urllib.error, sqlite3
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
class HTTPTest(unittest.TestCase):
 def test_real_http_restart_security_and_rate_limit(self):
  with tempfile.TemporaryDirectory() as directory:
   db=Path(directory)/'http.sqlite3'; port=4189; base=f'http://127.0.0.1:{port}'
   env={**os.environ,'PORT':str(port),'REVIVEX_DB':str(db)}
   def start():
    p=subprocess.Popen(['python3',str(ROOT/'dist/server.py')],env=env,stdout=subprocess.DEVNULL)
    for _ in range(80):
     try:
      urllib.request.urlopen(base+'/api/health',timeout=.5);return p
     except (OSError,urllib.error.URLError):time.sleep(.05)
    p.terminate();raise AssertionError('readiness failed')
   def request(path,data=None,origin=base):
    payload=None if data is None else json.dumps(data).encode()
    req=urllib.request.Request(base+path,data=payload,headers={'Content-Type':'application/json','Origin':origin})
    try:
     with urllib.request.urlopen(req) as r:return r.status,json.load(r)
    except urllib.error.HTTPError as r:return r.code,json.load(r)
   def submit(email='http-qa@example.test',**extra):
    token=request('/api/form')[1]['token'];time.sleep(1.02)
    return request('/api/signup',{'email':email,'consent':True,'token':token,**extra})
   p=start()
   try:
    self.assertEqual(request('/data/signups.sqlite3')[0],404)
    self.assertEqual(request('/server.py')[0],404)
    self.assertEqual(request('/api/signup',{},origin='https://evil.test')[0],403)
    self.assertEqual(request('/api/signup',{'email':'a@example.test','consent':True})[0],400)
    token=request('/api/form')[1]['token']
    payload={'email':'http-qa@example.test','consent':True,'token':token}
    self.assertEqual(request('/api/signup',payload)[0],400)
    time.sleep(1.05);self.assertEqual(request('/api/signup',payload)[0],201)
    self.assertEqual(request('/api/signup',payload)[0],400)
    self.assertEqual(submit('invalid')[0],400)
    self.assertEqual(submit(consent=False)[0],400)
    self.assertEqual(submit(website='spam')[0],400)
    self.assertEqual(submit()[0],200)
    self.assertEqual(submit('rate-limited@example.test')[0],429)
    with sqlite3.connect(db) as c:
     before=c.execute('select * from signups').fetchall();self.assertEqual(len(before),1)
    p.terminate();p.wait(5);p=start()
    self.assertEqual(submit()[0],200)
    with sqlite3.connect(db) as c:self.assertEqual(before,c.execute('select * from signups').fetchall())
   finally:p.terminate();p.wait(5)
