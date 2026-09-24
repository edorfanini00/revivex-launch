import unittest, tempfile, importlib.util, sqlite3
from pathlib import Path

class SignupTests(unittest.TestCase):
    def test_signup_is_saved_with_consent(self):
        path=Path(__file__).resolve().parents[1]/'server.py'
        self.assertTrue(path.exists(), 'signup server is not implemented')
        spec=importlib.util.spec_from_file_location('server', path)
        module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/'test.sqlite3'
            module.init_db(db)
            status,result=module.save_signup(db, {'email':' QA@Example.test ','consent':True})
            self.assertEqual(status,201)
            with sqlite3.connect(db) as conn:
                row=conn.execute('select email,consent,source,consented_at from signups').fetchone()
            self.assertEqual(row[:3],('qa@example.test',1,'appliance-early-release'))
            self.assertTrue(row[3])

    def test_validation_duplicate_and_persistence(self):
        import server
        with tempfile.TemporaryDirectory() as d:
            db=Path(d)/'test.sqlite3'; server.init_db(db)
            for payload in ({'email':'bad','consent':True},{'email':'a@example.test','consent':False},{'email':42,'consent':True},{'email':'a@example.test','consent':True,'website':'bot'}):
                self.assertEqual(server.save_signup(db,payload)[0],400)
            self.assertEqual(server.save_signup(db,{'email':'a@example.test','consent':True})[0],201)
            server.init_db(db)
            self.assertEqual(server.save_signup(db,{'email':'A@example.test','consent':True})[0],200)
            with sqlite3.connect(db) as c: self.assertEqual(c.execute('select count(*) from signups').fetchone()[0],1)

if __name__=='__main__': unittest.main()
