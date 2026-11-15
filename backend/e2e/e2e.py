"""Browser test of the whole ASTRA app (new UI) against a real backend, with a TEST STUB standing in for the AI model.
Run: python3 stub_model.py 18234 &   then start the backend (ASTRA_AI_PROVIDER=openai ASTRA_AI_URL=http://127.0.0.1:18234/v1), then python3 e2e.py
Env: ASTRA_E2E_URL, ASTRA_E2E_OUT (screenshots), ASTRA_E2E_DATA_RAW (backend data/raw), CHROME_PATH."""
import json, os, re, urllib.request
from playwright.sync_api import sync_playwright

BASE = os.environ.get('ASTRA_E2E_URL', 'http://127.0.0.1:8000')
OUT = os.environ.get('ASTRA_E2E_OUT', '.')
DATA_RAW = os.environ.get('ASTRA_E2E_DATA_RAW', 'data/raw')
results = []
def check(name, cond, detail=''):
    results.append((name, bool(cond), detail))
    print(('PASS ' if cond else 'FAIL ') + name + ((' :: ' + str(detail)[:300]) if (detail and not cond) else ''), flush=True)

def api(method, path, body=None):
    req = urllib.request.Request(BASE + '/api' + path, method=method, data=None if body is None else json.dumps(body).encode(), headers={'content-type': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=20) as r: return r.status, json.loads(r.read() or 'null')
    except urllib.error.HTTPError as e: return e.code, json.loads(e.read() or 'null')
def meas(aid=1): return api('GET', f'/measurements?astronaut_id={aid}&limit=3000')[1]
def alerts(): return api('GET', '/alerts?astronaut_id=1')[1]

# A fake browser speech engine, so the "Atlas" wake word and the voice view can be driven without a microphone.
FAKE_SPEECH = """
window.__recs = [];
class FakeRec {
  constructor() { this.continuous = false; this.interimResults = false; this.lang = ''; window.__recs.push(this); }
  start() { this.running = true; }
  stop() { this.running = false; setTimeout(() => this.onend && this.onend(), 10); }
  abort() { this.running = false; setTimeout(() => this.onend && this.onend(), 10); }
}
window.SpeechRecognition = FakeRec; window.webkitSpeechRecognition = FakeRec;
window.__say = (text, isFinal) => {
  const r = [...window.__recs].reverse().find((x) => x.running);
  if (!r) return false;
  r.onresult({ resultIndex: 0, results: [{ isFinal: !!isFinal, 0: { transcript: text } }] });
  if (isFinal && !r.continuous) { r.running = false; setTimeout(() => r.onend && r.onend(), 50); }   // a one-shot session ends by itself after the final words
  return true;
};
window.__silence = () => {
  const r = [...window.__recs].reverse().find((x) => x.running);
  if (!r) return false;
  r.running = false; setTimeout(() => r.onend && r.onend(), 20); return true;
};
window.__running = () => window.__recs.filter((x) => x.running).length;
"""

def open_text_atlas(p):
    p.get_by_label('Talk to Atlas').click()
    try: p.wait_for_selector('#atlas-q', timeout=5000)           # headless Chrome has no microphone: the voice view hands over to the text panel
    except Exception:
        p.get_by_text('Type instead').click(); p.wait_for_selector('#atlas-q', timeout=5000)

errors = []
def watch(page):
    page.on('pageerror', lambda e: errors.append('pageerror: ' + str(e)))
    page.on('console', lambda m: errors.append('console.error: ' + m.text + ' ' + str(m.location.get('url', ''))) if m.type == 'error' else None)
    page.on('requestfailed', lambda r: errors.append('requestfailed: ' + r.url) if '/api/' in r.url else None)
def guide_open(p): return p.get_by_label('Close the guide').count() > 0
def dismiss_guide(p):
    if guide_open(p): p.get_by_label('Close the guide').click(); p.wait_for_timeout(400)
def live(p): p.wait_for_selector('text=Live data', state='attached', timeout=25000)
def log_metric(p, tab, vals=None, mood=None):
    p.goto(BASE + f'/log?focus={tab}'); p.wait_for_selector('main h2, main h1', timeout=8000); p.wait_for_timeout(500); dismiss_guide(p)
    if mood: p.get_by_role('radio', name=re.compile(r'^' + mood)).click()
    else:
        for i, v in enumerate(vals): p.locator('input[type=number]').nth(i).fill(str(v))
    p.get_by_role('button', name='Save', exact=True).click(); p.wait_for_selector('text=Saved', timeout=8000); p.wait_for_timeout(600)

with sync_playwright() as pw:
    br = pw.chromium.launch(executable_path=os.environ.get('CHROME_PATH') or None, args=['--no-sandbox', '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])
    ctx = br.new_context(viewport={'width': 1280, 'height': 860})
    page = ctx.new_page(); watch(page); page.on('dialog', lambda d: d.accept())

    # ---- 0/1. starting state, live connection, every page
    st, r = api('POST', '/demo/reset'); check('reset endpoint restores the starting story', st == 200 and r.get('measurements') == 265, r)
    page.goto(BASE + '/'); live(page); page.wait_for_timeout(1500)
    check('header says Live data', page.get_by_text('Live data').count() >= 1)
    check('first visit shows the welcome guide', guide_open(page)); page.screenshot(path=OUT + '/shot_guide.png')
    dismiss_guide(page); page.wait_for_timeout(1500); page.screenshot(path=OUT + '/shot_home.png')
    check('home shows the server numbers (blood pressure 142/92 from the history)', '142/92' in page.inner_text('body'))
    check('home 3D body canvas renders', page.locator('canvas').count() >= 1)
    for route in ['/log', '/trends', '/routine', '/events', '/evidence', '/crew', '/scan', '/tests', '/reentry', '/cabin']:
        page.goto(BASE + route); page.wait_for_selector('main', timeout=10000); page.wait_for_timeout(900); dismiss_guide(page)
        t = page.inner_text('main')
        check(f'deep link {route} opens', len(t) > 60 and 'Not Found' not in t, t[:100])
        page.screenshot(path=f'{OUT}/shot{route.replace("/", "_")}.png')
    check('/eye camera page is served by the backend', urllib.request.urlopen(BASE + '/eye').status == 200)
    check('unknown /api path is JSON 404', api('GET', '/nope')[0] == 404)

    # ---- 2. server alerts and acknowledge
    page.goto(BASE + '/events'); page.wait_for_selector('summary:has-text("station server also flagged")')
    page.locator('summary:has-text("station server also flagged")').click()
    open_before = len([a for a in alerts() if a['status'] == 'open'])
    page.get_by_role('button', name='I have seen this').first.click(); page.wait_for_timeout(900)
    check('acknowledging a server alert is saved on the server', len([a for a in alerts() if a['status'] == 'open']) == open_before - 1)

    # ---- 3. a reading that needs action: blood pressure
    before = len(meas())
    page.goto(BASE + '/log?focus=bp'); page.wait_for_selector('input[type=number]')
    ins = page.locator('input[type=number]'); ins.nth(0).fill('168'); ins.nth(1).fill('104')
    page.get_by_role('button', name='Save', exact=True).click(); page.wait_for_selector('text=Start the 3 easy steps'); page.wait_for_timeout(1500)
    ms = meas(); check('two BP numbers reached the server', len(ms) == before + 2, (before, len(ms)))
    new = [m for m in ms if m['source_name'] == 'ASTRA check-in' and m['value'] in (168, 104)]
    check('server stored them with the app clock and the app check-in source', len(new) == 2 and all(m['measured_at'] >= '2026-11-13' for m in new), new)
    evs = api('GET', '/events?astronaut_id=1')[1]
    check('the act-now event was mirrored to the server', len(evs) == 1 and evs[0]['status'] != 'closed', evs)

    # ---- 4. the 3-step alert flow, saved state
    page.goto(BASE + '/events'); page.wait_for_selector('text=Step 1 of 3')
    page.get_by_text('I already did').click(); page.wait_for_selector('text=How do you feel?')
    page.get_by_role('button', name='Dizzy').click(); page.get_by_role('button', name='Next').click(); page.wait_for_selector('text=Tell the doctor')
    page.get_by_role('button', name='Send to the doctor').click(); page.wait_for_timeout(2500)
    s = api('GET', '/astronauts/1/state')[1]['state']
    check('app state (alert steps, points) is saved on the server', s and any(e['stage'] != 'respond' for e in s['events']) and s['xp'] > 1240, s and s.get('xp'))
    check('saved state carries the backend event id', s and s['events'][0].get('backendEventId') == evs[0]['id'])

    # ---- 5. wipe the browser storage: everything comes back from the server
    page.evaluate('localStorage.clear()'); page.reload(); live(page); page.wait_for_timeout(2500)
    page.goto(BASE + '/events'); page.wait_for_timeout(1500)
    check('after wiping browser storage the alert is still in recovery (state came from the server)', 'Step 1 of 3' not in page.inner_text('main') and ('Getting better' in page.inner_text('body') or 'recover' in page.inner_text('main').lower() or 'follow' in page.inner_text('main').lower()), page.inner_text('main')[:300])
    check('the points survived (1,240 plus the new ones)', re.search(r'1,2[5-9]\d|1,[3-9]\d\d', page.inner_text('body')) is not None, re.findall(r'[\d,]+\s*points', page.inner_text('body')))

    # ---- 6. demo clock: follow-up readings pushed, event closes on the server
    page.goto(BASE + '/'); live(page); dismiss_guide(page)
    for _ in range(4):
        page.keyboard.press('Shift+D'); page.wait_for_timeout(1300)
    page.wait_for_timeout(2000)
    check('simulated demo follow-ups stay in the app and are not stored as real readings', not any('demo follow-up' in m['source_name'] for m in meas()), len(meas()))
    check('the event is closed on the server once it closes in the app', api('GET', '/events?astronaut_id=1')[1][0]['status'] == 'closed', api('GET', '/events?astronaut_id=1')[1])

    # ---- 7. routine
    page.goto(BASE + '/routine'); page.wait_for_selector('[data-testid=server-plan]'); page.wait_for_timeout(800)
    check('server plan lists the 4 routines', page.locator('[data-testid=server-routine]').count() == 4, page.locator('[data-testid=server-routine]').count())
    page.get_by_role('button', name=re.compile(r'^Mark as done: ')).first.click(); page.wait_for_timeout(1000)
    check('ticking a server routine is saved', any(r['last_completed_at'] for r in api('GET', '/routines?astronaut_id=1')[1]))
    ex0 = len([m for m in meas() if m['indicator_code'] == 'exercise_minutes'])
    page.get_by_role('button', name='Mark as done', exact=True).first.click(); page.wait_for_timeout(1500)
    check('finishing a planned exercise session logs the minutes on the server', len([m for m in meas() if m['indicator_code'] == 'exercise_minutes']) == ex0 + 1, (ex0, [m['source_name'] for m in meas() if m['indicator_code'] == 'exercise_minutes'][-2:]))

    # ---- 8. Atlas, typed (the voice view's "Type instead")
    page.goto(BASE + '/'); live(page); dismiss_guide(page)
    check('the Atlas button and the "say Atlas" chip are on screen', page.get_by_label('Talk to Atlas').count() == 1 and page.locator('[data-testid=atlas-wake]').count() == 1)
    open_text_atlas(page)
    def ask(t, wait=2500):
        page.fill('#atlas-q', t); page.get_by_label('Ask', exact=True).click(); page.wait_for_timeout(wait)
    panel = lambda: page.locator('section[aria-label=Atlas]').inner_text()
    quick = lambda: page.get_by_role('button', name=re.compile(r'Quick save'))
    check('quick save is on by default', 'on' in quick().inner_text())
    quick().click(); check('quick save can be turned off (Atlas then asks first)', 'off' in quick().inner_text())
    ask('hello there'); check('Atlas answers a chat message', 'stub' in panel(), panel()[-200:])
    ask('how is my heart rate'); check('Atlas reads a value and says the real number', re.search(r'\d+\s*(bpm|beats)', panel()) is not None, panel()[-250:])
    check('showing the body lowers the typed panel but keeps the answer readable', page.get_by_label('Show Atlas').count() == 1 and page.locator('#atlas-q').count() == 0)
    page.get_by_label('Show Atlas').click(); page.wait_for_selector('#atlas-q')
    ask('switch to light mode'); check('Atlas changes the theme', page.evaluate("document.documentElement.classList.contains('light') || document.documentElement.dataset.theme === 'light'"), page.evaluate('document.documentElement.outerHTML.slice(0,120)'))
    ask('open the alerts page'); check('Atlas navigates and lowers itself', page.url.endswith('/events') and page.get_by_label('Show Atlas').count() == 1, page.url)
    page.get_by_label('Show Atlas').click(); page.wait_for_selector('#atlas-q')
    n0 = len(meas()); ask('log my sleep 7 hours')
    check('with quick save off Atlas asks for confirmation before writing', page.locator('[data-testid=atlas-confirm]').count() == 1 and len(meas()) == n0)
    page.click('[data-testid=atlas-approve]'); page.wait_for_timeout(2500)
    atl = [m for m in meas() if m['source_name'] == 'Atlas assistant']
    check('after approval the number is on the server, stamped with the app clock', len(meas()) == n0 + 1 and len(atl) == 1 and atl[0]['indicator_code'] == 'sleep_hours' and atl[0]['value'] == 7 and atl[0]['measured_at'] < '2026-11-16', atl)
    check('Atlas says exactly what it saved', 'Saved' in page.locator('[data-testid=atlas-settled]').last.inner_text(), page.locator('[data-testid=atlas-settled]').last.inner_text())
    page.screenshot(path=OUT + '/shot_atlas.png')
    ask('log my sleep 7 hours'); page.locator('[data-testid=atlas-cancel]').last.click(); page.wait_for_timeout(1200)
    check('cancelling writes nothing', len(meas()) == n0 + 1)
    quick().click(); ask('log my sleep 7 hours', 3000)
    check('with quick save on the command runs at once: saved, no question asked', len(meas()) == n0 + 2 and page.locator('[data-testid=atlas-confirm]').count() == 0, len(meas()) - n0)
    page.locator('[data-testid=atlas-activity] summary').click()
    check('the activity log lists what Atlas did', 'Saved' in page.locator('[data-testid=atlas-activity]').inner_text() and 'Opened' in page.locator('[data-testid=atlas-activity]').inner_text(), page.locator('[data-testid=atlas-activity]').inner_text())
    page.keyboard.press('Escape'); page.wait_for_timeout(400)
    page.goto(BASE + '/log?focus=sleep'); page.wait_for_timeout(1200); dismiss_guide(page)
    page.get_by_text('More: all your past numbers').click(); page.wait_for_timeout(400)
    check('the number Atlas logged shows up in the app', any('Sleep' in r and '7' in r for r in page.locator('table tbody tr').all_inner_texts()[:6]), page.locator('table tbody tr').all_inner_texts()[:3])

    # ---- 8a. Atlas by voice: the name wakes the microphone, it keeps listening, it does the commands
    vctx = br.new_context(viewport={'width': 1280, 'height': 860}); vctx.add_init_script(FAKE_SPEECH)
    vp = vctx.new_page(); watch(vp)
    dlg = lambda: vp.locator('div[role=dialog][aria-label="Talking to Atlas"]')
    def say(t, final=True): return vp.evaluate('([t, f]) => window.__say(t, f)', [t, final])
    def wait_listening(): vp.wait_for_function('window.__running() >= 1', timeout=15000)
    vp.goto(BASE + '/'); live(vp); vp.wait_for_timeout(1500); dismiss_guide(vp)
    wait_listening()
    check('while Atlas is closed it listens for its name', vp.locator('[data-testid=atlas-wake]').inner_text().strip().startswith('Say'), vp.locator('[data-testid=atlas-wake]').inner_text())
    say('blah blah', False); vp.wait_for_timeout(300)
    check('other words do not wake it', vp.locator('[data-testid=atlas-voicebar]').count() == 0)
    say('Atlas', False); vp.wait_for_selector('[data-testid=atlas-voicebar]', timeout=5000)
    check('saying "Atlas" opens the voice view with the bar (the microphone is on without a tap)', vp.locator('[data-testid=atlas-voicebar] canvas').count() == 1)
    vp.wait_for_timeout(500); vp.screenshot(path=OUT + '/shot_voice_listening.png')
    say('Atlas how is my heart rate', True)
    vt = ''; h = 999
    for _ in range(60):
        vp.wait_for_timeout(120)
        got = vp.evaluate("(() => { const d = document.querySelector('div[role=dialog][aria-label=\"Talking to Atlas\"]'); return d ? [d.innerText, d.getBoundingClientRect().height] : ['', 999]; })()")
        vt = got[0]
        if re.search(r'\d+\s*(bpm|beats)', vt):
            vp.wait_for_timeout(500)
            h = vp.evaluate("(() => { const d = document.querySelector('div[role=dialog][aria-label=\"Talking to Atlas\"]'); return d ? d.getBoundingClientRect().height : 0; })()") or got[1]
            vp.screenshot(path=OUT + '/shot_voice_answer.png'); break
    check('the spoken question is answered with the real value on screen', re.search(r'\d+\s*(bpm|beats)', vt) is not None, vt[:300])
    check('when the answer is on the 3D body, Atlas lowers itself to a slim strip', h < 260, h)
    vp.wait_for_selector('[data-testid=atlas-voicebar]', state='detached', timeout=15000)
    check('after the task is done Atlas goes idle by itself (no tap needed)', True)
    wait_listening()
    check('and the name listener is back, waiting to hear "Atlas" again', vp.locator('[data-testid=atlas-wake]').inner_text().strip().startswith('Say'), vp.locator('[data-testid=atlas-wake]').inner_text())
    say('Atlas', False); vp.wait_for_selector('[data-testid=atlas-voicebar]', timeout=5000)
    say('Atlas hello there', True)
    for _ in range(40):
        vp.wait_for_timeout(150)
        vt = dlg().inner_text() if dlg().count() else ''
        if 'stub' in vt: break
    check('a plain question is answered', 'stub' in vt, vt[:200])
    wait_listening()
    check('after a plain answer Atlas listens once more for a follow-up', dlg().count() == 1 and vp.locator('[data-testid=atlas-voicebar]').count() == 1)
    say('how is my heart rate', True)               # no need to say the name again
    for _ in range(40):
        vp.wait_for_timeout(150)
        vt = dlg().inner_text() if dlg().count() else ''
        if re.search(r'\d+\s*(bpm|beats)', vt): break
    check('a follow-up question without the name is answered too', re.search(r'\d+\s*(bpm|beats)', vt) is not None, vt[:300])
    vp.wait_for_selector('[data-testid=atlas-voicebar]', state='detached', timeout=15000); wait_listening()
    n1 = len(meas()); at1 = len([m for m in meas() if m['source_name'] == 'Atlas assistant'])
    say('Atlas log my sleep 7 hours', True)         # quick save: done at once, read back, then idle
    saw = False
    for _ in range(60):
        vp.wait_for_timeout(120)
        if vp.locator('[data-testid=atlas-did]').count() and 'Saved' in vp.locator('[data-testid=atlas-did]').inner_text(): saw = True; vp.screenshot(path=OUT + '/shot_voice_did.png'); break
    check('Atlas shows what it did on screen', saw)
    vp.wait_for_timeout(1500)
    check('a spoken log command is carried out at once and saved on the server', len(meas()) == n1 + 1 and len([m for m in meas() if m['source_name'] == 'Atlas assistant']) == at1 + 1, len(meas()) - n1)
    vp.wait_for_selector('[data-testid=atlas-voicebar]', state='detached', timeout=15000); wait_listening()
    vp.get_by_label('Talk to Atlas').click(); vp.wait_for_selector('[data-testid=atlas-voicebar]', timeout=5000)
    vp.get_by_role('button', name=re.compile('Quick save')).click(); n2 = len(meas())
    say('log my sleep 7 hours', True); vp.wait_for_selector('[data-testid=atlas-voice-confirm]', timeout=15000)
    check('with quick save off a spoken write waits for a yes: nothing saved yet', len(meas()) == n2)
    vp.wait_for_timeout(800); vp.screenshot(path=OUT + '/shot_voice_confirm.png')
    wait_listening(); vp.wait_for_timeout(400); vp.screenshot(path=OUT + '/shot_voice_confirm_listening.png')
    check('while Atlas waits for the yes, the question and the buttons stay on screen', vp.locator('[data-testid=atlas-voice-confirm]').count() == 1)
    say('yes', True); vp.wait_for_timeout(3000)
    check('saying yes saves it', len(meas()) == n2 + 1, len(meas()) - n2)
    vp.wait_for_selector('[data-testid=atlas-voicebar]', state='detached', timeout=15000); wait_listening()
    vp.get_by_label('Talk to Atlas').click(); vp.wait_for_selector('[data-testid=atlas-voicebar]', timeout=5000)
    vp.get_by_role('button', name=re.compile('Quick save')).click()
    wait_listening(); vp.evaluate('window.__silence()'); vp.wait_for_timeout(700); wait_listening()
    check('when nothing is heard Atlas tries again once, still open', dlg().count() == 1)
    vp.evaluate('window.__silence()')
    vp.wait_for_selector('[data-testid=atlas-voicebar]', state='detached', timeout=12000)
    check('after two silent rounds it goes back to sleep and the name listener returns', True); wait_listening()
    say('Atlas', False); vp.wait_for_selector('[data-testid=atlas-voicebar]', timeout=5000)
    say('Atlas thanks', True)
    vp.wait_for_selector('[data-testid=atlas-voicebar]', state='detached', timeout=15000)
    check('saying "thanks" ends the conversation and closes the view', True)
    wait_listening()
    say('Atlas', False); vp.wait_for_selector('[data-testid=atlas-voicebar]', timeout=5000)
    vp.get_by_label('Close Atlas').first.click(); vp.wait_for_timeout(500)
    check('the × button closes the voice view', vp.locator('[data-testid=atlas-voicebar]').count() == 0)
    vp.get_by_test_id('atlas-wake').click(); vp.wait_for_timeout(600)
    check('the name chip turns listening off', 'off' in vp.locator('[data-testid=atlas-wake]').inner_text().lower() and vp.evaluate('window.__running()') == 0, vp.locator('[data-testid=atlas-wake]').inner_text())
    vctx.close()

    # ---- 8b. every kind of number, typed on screen, lands on the server in the right unit
    page.goto(BASE + '/'); live(page)
    log_metric(page, 'sleep', [6.5]); log_metric(page, 'hr', [66]); log_metric(page, 'temp', [36.8]); log_metric(page, 'bp', [121, 79]); log_metric(page, 'glucose', [91]); log_metric(page, 'mood', mood='4'); log_metric(page, 'exercise', [45])
    page.wait_for_timeout(1500)
    got = {(m['indicator_code'], m['value']): m for m in meas() if m['source_name'] == 'ASTRA check-in'}
    for key in [('sleep_hours', 6.5), ('heart_rate', 66.0), ('body_temp', 36.8), ('bp_systolic', 121.0), ('bp_diastolic', 79.0), ('glucose', 91.0), ('mood', 4.0), ('exercise_minutes', 45.0)]:
        m = got.get(key); check(f'{key[0]} typed on screen is on the server with value {key[1]}', m is not None and m['quality'] == 'ok', m or sorted(got))

    # ---- 8c. trends / progress pages draw real data
    page.goto(BASE + '/trends'); page.wait_for_timeout(1800); dismiss_guide(page)
    check('trends page draws charts', page.locator('main svg').count() >= 3, page.locator('main svg').count())
    page.goto(BASE + '/crew'); page.wait_for_timeout(800); check('progress page loads', len(page.inner_text('main')) > 60)

    # ---- 8d. cabin, import, sources, eye
    open(DATA_RAW + '/tiny_env.csv', 'w').write('datetime,temperature_c,co2_ppm,humidity_pct\n2026-11-01T00:00:00Z,22.5,2600,40\n2026-11-01T00:05:00Z,22.6,2610,41\n')
    page.goto(BASE + '/cabin'); page.wait_for_selector('[data-testid=cabin-card]'); page.wait_for_timeout(1500)
    page.select_option('select[aria-label="Cabin parameter"]', 'co2'); page.fill('input[aria-label="Value to check"]', '9000'); page.get_by_role('button', name='Check').click(); page.wait_for_selector('[data-testid=assess-result]', timeout=8000)
    check('checking an extreme CO2 value is answered (needs the cabin model)', len(page.inner_text('[data-testid=assess-result]')) > 10, page.inner_text('[data-testid=assess-result]'))
    page.fill('input[aria-label="Value to check"]', 'abc'); page.get_by_role('button', name='Check').click(); page.wait_for_timeout(300)
    check('a non-number is refused with a message', 'number' in page.inner_text('main').lower())
    page.locator('[data-testid=import-card] select').nth(0).select_option('tiny_env.csv'); page.locator('[data-testid=import-card] select').nth(1).select_option('example_environment.json')
    page.get_by_role('button', name='Import', exact=True).click(); page.wait_for_selector('[data-testid=import-report]', timeout=20000)
    check('importing a CSV from the page shows the report', '"inserted"' in page.inner_text('[data-testid=import-report]'), page.inner_text('[data-testid=import-report]')[:200])
    check('the import appears in the log', 'tiny_env.csv' in page.inner_text('[data-testid=import-log]'))
    check('eye card links to the camera page', page.locator('[data-testid=eye-card] a[href="/eye"]').count() == 1)
    check('sources card lists the recorded sources', page.locator('[data-testid=sources-card] li').count() >= 5)

    # ---- 8e. a second astronaut through Atlas
    page.goto(BASE + '/'); live(page); dismiss_guide(page)
    open_text_atlas(page)
    if 'Sara' not in [a['display_name'] for a in api('GET', '/astronauts')[1]]:
        ask('add astronaut Sara'); page.click('[data-testid=atlas-approve]'); page.wait_for_timeout(2000)
    check('Atlas added an astronaut after confirmation', 'Sara' in [a['display_name'] for a in api('GET', '/astronauts')[1]])
    ask('switch to astronaut Sara', 3000)
    check('switching to Sara changes the app to her record', page.evaluate('document.body.innerText').count('Sara') >= 1, page.inner_text('body')[:200])
    page.keyboard.press('Escape')
    for route in ['/', '/log', '/events', '/trends', '/routine', '/cabin']:
        page.goto(BASE + route); page.wait_for_timeout(1500); dismiss_guide(page)
        check(f'Sara: {route} opens', len(page.inner_text('main')) > 50, page.inner_text('main')[:80])

    # ---- 9. back to the demo astronaut and reset with Shift+R
    page.goto(BASE + '/'); live(page); dismiss_guide(page)
    open_text_atlas(page); ask('switch to astronaut Cmdr', 3000); page.keyboard.press('Escape'); page.wait_for_timeout(500)
    page.keyboard.press('Shift+R'); page.wait_for_timeout(4000)
    check('Shift+R resets the server too', len(meas()) == 265 and api('GET', '/events?astronaut_id=1')[1] == [] and (api('GET', '/astronauts/1/state')[1]['state'] or {}).get('xp', 1240) == 1240 and not (api('GET', '/astronauts/1/state')[1]['state'] or {}).get('events'), (len(meas()), str(api('GET', '/astronauts/1/state')[1])[:200]))
    check('after the reset the home page shows the starting story again', '142/92' in page.inner_text('body'))

    # ---- 10. backend down: demo mode, still usable
    ctx2 = br.new_context(viewport={'width': 1280, 'height': 860}); p2 = ctx2.new_page()
    p2.route('**/api/**', lambda r: r.abort())
    p2.goto(BASE + '/'); p2.wait_for_selector('text=Demo data', state='attached', timeout=25000); p2.wait_for_timeout(800); dismiss_guide(p2)
    check('with the backend unreachable the app says Demo data and shows the sample story', '142/92' in p2.inner_text('body'))
    p2.goto(BASE + '/log?focus=hr'); p2.wait_for_selector('input[type=number]'); dismiss_guide(p2); p2.fill('input[type=number]', '64'); p2.get_by_role('button', name='Save', exact=True).click(); p2.wait_for_timeout(800)
    check('demo mode still lets a person log a number', p2.get_by_text('Saved').count() >= 1)
    ctx2.close()

    # ---- 11. phone-size layout
    ctx3 = br.new_context(viewport={'width': 390, 'height': 800}, is_mobile=True); p3 = ctx3.new_page(); watch(p3)
    p3.goto(BASE + '/'); live(p3); p3.wait_for_timeout(1500); dismiss_guide(p3); p3.screenshot(path=OUT + '/shot_mobile.png')
    check('phone layout has no sideways overflow', not p3.evaluate('document.documentElement.scrollWidth > window.innerWidth + 2'))
    p3.get_by_label('Talk to Atlas').click(); p3.wait_for_timeout(1500); p3.screenshot(path=OUT + '/shot_mobile_atlas.png')
    check('Atlas opens on a phone', p3.get_by_label('Close Atlas').count() >= 1)
    ctx3.close()
    br.close()

bad = [e for e in errors if 'favicon' not in e and 'SpeechRecognition' not in e and 'ERR_ABORTED' not in e]
check('no page errors or failed API calls in the browser console', not bad, bad[:6])
print('\nSUMMARY', sum(1 for r in results if r[1]), '/', len(results))
json.dump(results, open(OUT + '/e2e_results.json', 'w'))
