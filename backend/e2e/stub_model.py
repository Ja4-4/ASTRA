"""TEST STUB (not the real model): an OpenAI-compatible server that answers a few fixed phrases so the
backend -> Atlas panel pipeline can be exercised in a browser. The real model runs on the user's PC."""
import json, sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

def decide(t):
    t = t.lower()
    A = lambda name, args, reply, lang='en': {'reply': reply, 'lang': lang, 'action': {'name': name, 'args': args}}
    if 'sleep' in t and 'log' in t: return A('log_measurement', {'indicator': 'sleep_hours', 'value': '7'}, 'I will log 7 hours of sleep.')
    if 'heart rate' in t: return A('get_latest', {'indicator': 'heart_rate'}, 'Here is your latest heart rate.')
    if 'light mode' in t: return A('set_theme', {'mode': 'light'}, 'Switching to light mode.')
    if 'alerts page' in t: return A('navigate', {'page': 'events'}, 'Opening the alerts page.')
    if 'routine page' in t: return A('navigate', {'page': 'routine'}, 'Opening the routine page.')
    if 'add astronaut' in t: return A('add_astronaut', {'name': 'Sara', 'setting': 'station'}, 'I will add Sara.')
    if 'switch to astronaut' in t:
        name = t.split('switch to astronaut')[1].strip().split()[0].capitalize()
        return A('select_astronaut', {'name': name}, 'Switching.')
    if 'acknowledge alert' in t:
        n = [w for w in t.replace('?', ' ').split() if w.isdigit()]
        return A('acknowledge_alert', {'alert_id': n[0] if n else '1'}, 'I will acknowledge it.')
    return {'reply': 'Hello, I am a stub.', 'lang': 'en', 'action': None}

class H(BaseHTTPRequestHandler):
    def log_message(self, *a): pass
    def _send(self, obj):
        b = json.dumps(obj).encode(); self.send_response(200); self.send_header('content-type', 'application/json'); self.send_header('content-length', str(len(b))); self.end_headers(); self.wfile.write(b)
    def do_GET(self): self._send({'data': [{'id': 'ai'}]})
    def do_POST(self):
        n = int(self.headers.get('content-length', 0)); body = json.loads(self.rfile.read(n))
        last = [m for m in body['messages'] if m['role'] == 'user'][-1]['content']
        self._send({'choices': [{'message': {'role': 'assistant', 'content': json.dumps(decide(last))}}]})

ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1])), H).serve_forever()
