// Optional real-browser regression, no npm dependencies:
// BB_TEST_CHROMIUM=/usr/bin/chromium node --test tests/experimentation-browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startStaticServer } = require('../electron/static-server.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Experimentation real-browser layout, feedback, session, and input lifecycle', {
  skip: !process.env.BB_TEST_CHROMIUM,
  timeout: 900000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'bb-experimentation-'));
  const server = await startStaticServer();
  const chrome = spawn(process.env.BB_TEST_CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
    '--disable-background-timer-throttling', '--disable-renderer-backgrounding',
    '--disable-backgrounding-occluded-windows',
    '--use-angle=swiftshader', '--enable-unsafe-swiftshader',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let output = '';
  chrome.stderr.on('data', chunk => { output += chunk; });
  let socket;
  t.after(async () => {
    socket?.close();
    chrome.kill('SIGTERM');
    await Promise.race([new Promise(resolve => chrome.exitCode !== null || chrome.signalCode ? resolve() : chrome.once('exit', resolve)), delay(2000)]);
    if (chrome.exitCode === null && !chrome.signalCode) chrome.kill('SIGKILL');
    server.server.closeAllConnections();
    await server.close();
    await rm(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  let url;
  for (let n = 0; n < 600 && !url; n++) {
    url = output.match(/DevTools listening on (ws:\/\/[^\s]+)/)?.[1];
    if (!url) {
      const portFile = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').catch(() => '');
      const [port, path] = portFile.trim().split('\n');
      if (port && path) url = `ws://127.0.0.1:${port}${path}`;
    }
    if (!url) await delay(100);
  }
  assert.ok(url, `Chromium did not start: ${output.slice(-2000)}`);
  socket = new WebSocket(url);
  await new Promise((resolve, reject) => { socket.addEventListener('open', resolve); socket.addEventListener('error', reject); });
  const pending = new Map();
  const exceptions = [];
  let counter = 0, sessionId;
  socket.addEventListener('message', event => {
    const data = JSON.parse(event.data);
    if (data.method === 'Runtime.exceptionThrown') exceptions.push(data.params.exceptionDetails);
    if (data.id && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(JSON.stringify(data.error))) : resolve(data.result);
    }
  });
  const send = (method, params = {}, session = sessionId) => new Promise((resolve, reject) => {
    const id = ++counter;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result); }, reject: error => { clearTimeout(timer); reject(error); } });
    socket.send(JSON.stringify({ id, method, params, ...(session ? { sessionId: session } : {}) }));
  });
  const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
  ({ sessionId } = await send('Target.attachToTarget', { targetId, flatten: true }));
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `
    Object.defineProperty(window, '_app', {
      configurable: true,
      get() { return window.__testApp; },
      set(app) {
        window.__testApp = app;
        const setStatus = app.setStatus.bind(app);
        app.setStatus = message => { window.__testReady = message; setStatus(message); };
      },
    });
  ` });
  await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  await send('Page.navigate', { url: server.appUrl });
  const evaluate = async expression => {
    const data = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    assert.ok(!data.exceptionDetails, JSON.stringify(data.exceptionDetails));
    return data.result.value;
  };
  for (let n = 0; n < 300; n++) {
    if (await evaluate(`window.__testReady === 'Ready'`)) break;
    await delay(100);
  }
  assert.equal(await evaluate(`window.__testReady`), 'Ready');

  await t.test('Goal cards default: real isolated WASM preview, frozen evidence and untouched workspace', async () => {
    const initial = await evaluate(`(async () => {
      const app = _app;
      app._toggleSimulationMode(true);
      app.experimentation.show();
      // Let the host draw its mode-switch guide overlay before comparing it.
      await new Promise(resolve => setTimeout(resolve, 150));
      window.__goalSnapshot = () => JSON.stringify({
        layers: app.layers.map(l => ({id:l.id, paint:l.canvas.toDataURL(), width:l.canvas.width, height:l.canvas.height})),
        active: app.activeLayerIdx, nextLayer: app._nextLayerId,
        undo: app.undoStack, redo: app.redoStack, sessions: app.simulation.sessions,
        data: app.simulation.brushData, vars: app.simulation.vars,
        frame: app.simulation.frameCount, activeSession: app.simulation.activeSessionIndex,
        savedPlayback: app.simulation.savedPlayback,
        controls: app._captureSimulationSessionControlState(),
        storage: Object.fromEntries(Object.keys(localStorage).filter(k=>k!=='bb_goal_cards_v1').map(k=>[k,localStorage.getItem(k)])),
        // liveCanvas is the host's independently animated guide overlay, not
        // committed paint. Compare its persistent painting presentation instead.
        composite: app.compositeCanvas.toDataURL()
      });
      window.__goalBefore = __goalSnapshot();
      window.__goalChanges = () => {
        const before=JSON.parse(__goalBefore),after=JSON.parse(__goalSnapshot());
        return Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));
      };
      window.__goalSharedSim = app.sharedMotionSim;
      const tab = app.experimentation.tab;
      document.getElementById('goalTryExample').click();
      document.getElementById('goalRun').click();
      return {tab, running:app.experimentation.goals.runner.running};
    })()`);
    assert.deepEqual(initial, { tab: 'goals', running: true });
    for (let n = 0; n < 80 && await evaluate(`_app.experimentation.goals.runner.running`); n++) await delay(100);
    const run = await evaluate(`(() => {
      const g = _app.experimentation.goals, r = g.store.reviews.at(-1);
      const before=JSON.parse(__goalBefore),after=JSON.parse(__goalSnapshot());
      const changes=Object.keys(before).filter(k=>JSON.stringify(before[k])!==JSON.stringify(after[k]));
      return {result:r?.result, message:g.message, changes, same:__goalBefore === __goalSnapshot(), shared:__goalSharedSim===_app.sharedMotionSim};
    })()`);
    assert.equal(run.result?.status, 'completed', JSON.stringify(run));
    assert.equal(run.result.frames, 90);
    assert.equal(run.result.capturedFrames, 90);
    assert.equal(run.result.framesExact, true);
    assert.equal(run.result.simulationSeconds, 1.5);
    assert.equal(run.result.backend, 'wasm / canvas2d');
    assert.ok(run.result.wallMilliseconds < 3250);
    assert.match(run.result.png, /^data:image\/png;base64,/);
    assert.equal(run.same, true, 'No host layer/history/session/storage/canvas mutation: '+JSON.stringify(run.changes));
    assert.equal(run.shared, true, 'Host shared simulator is not replaced');
    const pixels = await evaluate(`(async () => {
      const image = document.getElementById('goalPreviewImage'); await image.decode();
      const c=document.createElement('canvas'); c.width=image.naturalWidth;c.height=image.naturalHeight;
      const ctx=c.getContext('2d');ctx.drawImage(image,0,0);
      const p=ctx.getImageData(0,0,c.width,c.height).data;
      let blue=0;for(let i=0;i<p.length;i+=4)if(p[i+2]>p[i]+10)blue++;
      window.__goalFrozen=image.src;
      return {blue,width:c.width,height:c.height};
    })()`);
    assert.equal(pixels.width, 384); assert.equal(pixels.height, 384);
    assert.ok(pixels.blue > 50, 'Actual visible blue brush stamps, not just a backend label');
    await delay(150);
    assert.equal(await evaluate(`document.getElementById('goalPreviewImage').src === __goalFrozen`), true);
  });

  await t.test('Goal navigation retains image, neutral/unanswered/N/A, notes and rerun history', async () => {
    const ratings = await evaluate(`(() => {
      const q=document.querySelectorAll('.goal-question');
      const slider=q[0].querySelector('input[type=range]');
      slider.value='-37';slider.dispatchEvent(new Event('input',{bubbles:true}));
      const scalar=_app.experimentation.goals.store.reviews[0].answers[0].value;
      [...q[0].querySelectorAll('button')].find(b=>b.textContent==='Clear answer').click();
      const cleared=_app.experimentation.goals.store.reviews[0].answers[0].value;
      [...q[0].querySelectorAll('button')].find(b=>b.textContent==='Neutral (0)').click();
      [...q[1].querySelectorAll('button')].find(b=>b.textContent==='N/A').click();
      const notes=document.getElementById('goalNotes');notes.value='<img src=x onerror=alert(1)> observed';
      notes.dispatchEvent(new Event('input',{bubbles:true}));
      document.getElementById('goalNext').click();
      const unanswered=!document.querySelector('.goal-question');
      document.getElementById('goalPrevious').click();
      return {scalar,cleared,unanswered, values:_app.experimentation.goals.store.reviews[0].answers.map(a=>a.value),
        note:document.getElementById('goalNotes').value,
        same:document.getElementById('goalPreviewImage').src===__goalFrozen};
    })()`);
    assert.deepEqual(ratings.values, [0, 'na']);
    assert.equal(ratings.scalar, -37); assert.equal(ratings.cleared, null);
    assert.equal(ratings.unanswered, true); assert.equal(ratings.same, true);
    assert.match(ratings.note, /observed/);
    await evaluate(`document.getElementById('goalRun').click()`);
    for (let n = 0; n < 80 && await evaluate(`_app.experimentation.goals.runner.running`); n++) await delay(100);
    const history = await evaluate(`(() => {
      const g=_app.experimentation.goals, select=document.getElementById('goalRunHistory');
      select.value=g.store.reviews[0].id;select.dispatchEvent(new Event('change',{bubbles:true}));
      return {count:g.store.reviews.length,sealed:g.store.reviews[0].sealed,
        disabled:document.querySelector('.goal-question').disabled,
        fresh:g.store.reviews[1].answers.map(a=>a.value),
        first:g.store.reviews[0].result.png,second:g.store.reviews[1].result.png,
        changes:__goalChanges(),sameHost:__goalBefore===__goalSnapshot()};
    })()`);
    assert.equal(history.count, 2); assert.equal(history.sealed, true); assert.equal(history.disabled, true);
    assert.deepEqual(history.fresh, [null, null]);
    assert.equal(history.first, history.second, 'Same fresh internal seed/config gives the same PNG in this build');
    assert.equal(history.sameHost, true, JSON.stringify(history.changes));
  });

  await t.test('Goal actual import/export controls, collision safety, revisions and persisted PNGs', async () => {
    const results = await evaluate(`(async () => {
      const g=_app.experimentation.goals;
      const original=URL.createObjectURL;
      window.__goalDownloads=[];
      URL.createObjectURL=blob=>{ __goalDownloads.push(blob); return original(blob); };
      try {
        document.getElementById('goalExport').click();
        document.getElementById('goalExample').click();
        document.getElementById('goalSchema').click();
      } finally {URL.createObjectURL=original;}
      const [reviewed,example,cap]=await Promise.all(__goalDownloads.map(async b=>JSON.parse(await b.text())));
      const inputFile=async value=>{
        const input=document.querySelector('#experimentationContent input[type=file]');
        const dt=new DataTransfer();dt.items.add(new File([JSON.stringify(value)],'deck.json',{type:'application/json'}));
        input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
        await new Promise(r=>setTimeout(r,40));
      };
      const collision=structuredClone(example);collision.cards[0].hypothesis='changed under same identity';
      await inputFile(collision);
      const rejected=document.getElementById('goalStatus').textContent;
      const child=structuredClone(example);child.revisionId='r2';child.parentRevisionId='r1';child.changes=['Increase separation'];
      child.cards[0].config.params.separation=.6;
      await inputFile(child);
      const historical=g.store.isHistorical(g.store.revisions[0]);
      const model=await import('./goal-card-model.js');
      model.validateBundle(reviewed);
      const restored=new model.GoalCardStore(localStorage);
      const bad=structuredClone(child);bad.revisionId='r3';bad.parentRevisionId='r2';bad.cards[0].config.url='https://example.invalid';
      await inputFile(bad);
      return {format:reviewed.format,scale:reviewed.scale, png:!!reviewed.reviews[0].result.png,
        complete:!!reviewed.revisions[0].cards[0].config.params.flowScale,
        cap:cap.schema.properties.format.enum[0],example:example.cards.length,rejected,
        revisions:g.store.revisions.length,historical,restored:restored.reviews.length,
        bad:document.getElementById('goalStatus').textContent,
        agent:await fetch('./simulation-card-designer.agent.md').then(r=>r.text()),
        sameHost:__goalBefore===__goalSnapshot()};
    })()`);
    assert.equal(results.format, 'boid-brush-reviewed-deck');
    assert.equal(results.scale.unanswered, null); assert.equal(results.scale.neutral, 0);
    assert.equal(results.scale.notApplicable, 'na');
    assert.ok(results.png && results.complete);
    assert.equal(results.cap, 'boid-brush-goal-deck'); assert.equal(results.example, 2);
    assert.match(results.rejected, /identity collision/); assert.match(results.bad, /unknown field/);
    assert.equal(results.revisions, 2); assert.equal(results.historical, true);
    assert.equal(results.restored, 2); assert.equal(results.sameHost, true);
    assert.match(results.agent, /Initial mode/);
  });

  await t.test('Goal byte-budget rejection warns without truncating notes; downloaded backup round-trips', async () => {
    const checked = await evaluate(`(async () => {
      const model=await import('./goal-card-model.js');
      const {GoalCardsView}=await import('./goal-card-ui.js');
      // Memory storage avoids browser quota masking the aggregate export limit.
      const data=new Map(), storage={getItem:k=>data.get(k),setItem:(k,v)=>data.set(k,v)};
      const seed=new model.GoalCardStore(storage), example=model.createExampleDeck();
      example.sharedQuestions=Array.from({length:12},(_,i)=>({id:'shared-'+i,text:'Question?'}));
      example.cards[0].questions=Array.from({length:8},(_,i)=>({id:'card-'+i,text:'Question?'}));
      const deck=seed.import(example);
      const result={status:'cancelled',frames:0,framesExact:true,capturedFrames:0,simulationSeconds:0,
        wallMilliseconds:30,backend:'unavailable',randomness:model.RANDOMNESS,message:'',png:null};
      const run=seed.addRun(deck,deck.cards[0],result), bundle=seed.bundle();
      bundle.reviews=Array.from({length:65},(_,i)=>({...structuredClone(run),id:'review-'+i,sealed:i!==64,
        answers:run.answers.map(a=>({...a,note:'界'.repeat(4000)}))}));
      const size=value=>new TextEncoder().encode(model.serializeReviewedDeck(value)).length;
      let remaining=model.LIMITS.importBytes-size(bundle);
      for(const row of bundle.reviews.slice(0,-1)){
        const bytes=Math.min(remaining,36000);
        row.notes='界'.repeat(Math.floor(bytes/3))+'x'.repeat(bytes%3);remaining-=bytes;
      }
      if(remaining!==0)throw new Error('Boundary fixture did not fit');
      storage.setItem(model.GOAL_KEY,JSON.stringify(bundle));
      const g=new GoalCardsView(storage), root=document.createElement('div');
      const raw=storage.getItem(model.GOAL_KEY);
      g.mount(root);
      try {
        const notes=root.querySelector('#goalNotes');
        notes.value='界';notes.dispatchEvent(new Event('input',{bubbles:true}));
        const editWarning=root.querySelector('#goalStatus').textContent;
        const draft=notes.value, saved=g.store.reviews.at(-1).notes;
        const input=root.querySelector('input[type=file]'), dt=new DataTransfer();
        const child=structuredClone(deck);child.revisionId='r2';child.parentRevisionId='r1';child.changes=['New revision'];
        dt.items.add(new File([JSON.stringify(child)],'deck.json',{type:'application/json'}));
        input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
        await new Promise(r=>setTimeout(r,40));
        const importWarning=root.querySelector('#goalStatus').textContent;
        g.runner.run=async()=>result;await g.start();
        const runWarning=root.querySelector('#goalStatus').textContent;
        const original=URL.createObjectURL;let backup;
        URL.createObjectURL=blob=>{backup=blob;return original(blob);};
        try {root.querySelector('#goalExport').click();} finally {URL.createObjectURL=original;}
        const text=await backup.text();
        const restored=new model.GoalCardStore({getItem:()=>null,setItem(){}});
        restored.import(model.parseImport(text));
        return {editWarning,importWarning,runWarning,draft,saved,bytes:backup.size,
          pretty:text===model.serializeReviewedDeck(bundle),
          unchanged:storage.getItem(model.GOAL_KEY)===raw&&JSON.stringify(g.store.bundle())===raw,
          roundTrip:restored.reviews.length===65&&restored.reviews[0].answers[0].note==='界'.repeat(4000),
          sealed:g.store.reviews.at(-1).sealed};
      } finally {g.unmount();}
    })()`);
    for (const warning of [checked.editWarning, checked.importWarning, checked.runWarning]) {
      assert.match(warning, /change rejected: total UTF-8 backup exceeds 16 MB/);
      assert.match(warning, /Existing evidence is unchanged; no notes were truncated/);
    }
    assert.equal(checked.draft, '界'); assert.equal(checked.saved, '');
    assert.equal(checked.bytes, 16000000);
    assert.equal(checked.pretty, true); assert.equal(checked.unchanged, true);
    assert.equal(checked.roundTrip, true); assert.equal(checked.sealed, false);
  });

  await t.test('Goal real cancellation, timeout, close lifecycle and phone layout stay bounded', async () => {
    const cancelled = await evaluate(`(async () => {
      const g=_app.experimentation.goals;
      const pending=g.start();document.getElementById('goalCancel').click();await pending;
      return g.store.reviews.at(-1).result;
    })()`);
    assert.equal(cancelled.status, 'cancelled'); assert.ok(cancelled.wallMilliseconds < 2000);
    const timeout = await evaluate(`(async () => {
      const g=_app.experimentation.goals;
      const d=structuredClone(g.deck);d.revisionId='r3';d.parentRevisionId='r2';d.changes=['Short deadline stress'];
      d.cards[0].budget={frames:180,wallSeconds:.5};
      d.cards[0].config.spawns[0].count=128;g.importValue(d);
      await g.start();return g.store.reviews.at(-1).result;
    })()`);
    assert.equal(timeout.status, 'timeout', JSON.stringify(timeout));
    assert.ok(timeout.wallMilliseconds < 1500);
    assert.ok(timeout.frames < 180); assert.equal(timeout.simulationSeconds, timeout.frames / 60);
    const closed = await evaluate(`(async () => {
      const g=_app.experimentation.goals, p=g.start();
      _app.experimentation.close();await p;
      return {status:g.store.reviews.at(-1).result.status,running:g.runner.running,
        open:_app.experimentation.open,same:__goalBefore===__goalSnapshot()};
    })()`);
    assert.deepEqual(closed, { status: 'cancelled', running: false, open: false, same: true });
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: false });
    await evaluate(`_app.experimentation.show()`);
    await delay(100);
    assert.ok(await evaluate(`(() => {const c=document.getElementById('experimentationContent');return c.scrollWidth-c.clientWidth<=1;})()`), 'Goal cards fit the existing 40% phone panel');
    await evaluate(`_app.experimentation.close()`);
    await send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
  });

  await t.test('opening reflows 60/40 without changing paint or backing dimensions, and closing restores view', async () => {
    const result = await evaluate(`(() => {
      const app = _app;
      app._toggleSimulationMode(true);
      app._applyViewState({zoom: 0.8, panX: 43, panY: -21, rotation: 0.3, flipped: true});
      window.__beforeView = app._captureViewState();
      window.__beforePaint = app.layers.map(l => l.canvas.toDataURL());
      window.__beforeDimensions = [app.W, app.H, ...app.layers.flatMap(l => [l.canvas.width, l.canvas.height])];
      document.getElementById('experimentationLaunch').click();
      return {open: app.experimentation.open, inert: document.getElementById('rightPanel').inert,
        saved: app._captureSessionControls()._view, before: window.__beforeView};
    })()`);
    assert.equal(result.open, true);
    assert.equal(result.inert, true);
    assert.deepEqual(result.saved, result.before);
    await delay(100);
    assert.deepEqual(await evaluate(`(() => {
      const area = document.getElementById('canvasArea').getBoundingClientRect();
      const dialog = document.getElementById('experimentationDialog').getBoundingClientRect();
      return {canvasRight: area.right, dialogLeft: dialog.left, width: dialog.width};
    })()`), { canvasRight: 768, dialogLeft: 768, width: 512 });
    assert.equal(await evaluate(`JSON.stringify(__beforePaint) === JSON.stringify(_app.layers.map(l => l.canvas.toDataURL()))`), true);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    assert.deepEqual(await evaluate(`_app._captureViewState()`), result.before);
    assert.equal(await evaluate(`document.getElementById('rightPanel').inert`), false);
    assert.equal(await evaluate(`document.activeElement.id`), 'experimentationLaunch');
    assert.equal(await evaluate(`document.getElementById('canvasArea').getBoundingClientRect().width`), 1280);
  });

  await t.test('pointer curves, keyboard neutral, N/A, notes and local persistence use real controls', async () => {
    await evaluate(`document.getElementById('experimentationLaunch').click()`);
    await evaluate(`_app.experimentation.selectTab('current')`);
    const rect = await evaluate(`(() => {
      const svg = document.querySelector('.experiment-curve');
      svg.scrollIntoView({block:'center'});
      const r = svg.getBoundingClientRect(); return {x:r.x,y:r.y,w:r.width,h:r.height};
    })()`);
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x + rect.w * .05, y: rect.y + rect.h * .88, button: 'left', clickCount: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x + rect.w * .95, y: rect.y + rect.h * .12, button: 'left', buttons: 1 });
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x + rect.w * .95, y: rect.y + rect.h * .12, button: 'left', clickCount: 1 });
    const curve = await evaluate(`_app.experimentation.store.records.get(_app._getExperimentationContext().id).answers.cohesion.curve`);
    assert.equal(curve.length, 5);
    assert.ok(curve[0] < -80 && curve[4] > 80 && curve.every(v => v !== null), JSON.stringify(curve));
    await evaluate(`(() => {
      const field = document.querySelectorAll('.experiment-question')[1];
      field.querySelector('details').open = true;
      field.querySelector('input').focus();
    })()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter' });
    assert.deepEqual(await evaluate(`_app.experimentation.store.records.get(_app._getExperimentationContext().id).answers.alignment.curve`), [0, null, null, null, null]);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
    assert.equal(await evaluate(`_app.experimentation.store.records.get(_app._getExperimentationContext().id).answers.alignment.curve[0]`), 1);
    await evaluate(`(() => {
      const field = document.querySelectorAll('.experiment-question')[1];
      [...field.querySelectorAll('button')].find(b => b.textContent === 'Not applicable').click();
      const note = field.querySelector('textarea');
      note.value = '<img src=x onerror=alert(1)> observation';
      note.dispatchEvent(new Event('input', {bubbles:true}));
    })()`);
    assert.equal(await evaluate(`document.querySelectorAll('#experimentationDialog img').length`), 0);
    assert.equal(await evaluate(`JSON.parse(localStorage.getItem('bb_experimentation_v1')).records[0].answers.alignment.notApplicable`), true);
    assert.equal(await evaluate(`_app.simulation.running`), false);
    assert.equal(await evaluate(`JSON.stringify(__beforePaint) === JSON.stringify(_app.layers.map(l => l.canvas.toDataURL()))`), true);
  });

  await t.test('starters add safely, cards navigate without load, explicit loading preserves draft feedback', async () => {
    const result = await evaluate(`(() => {
      window.__draftId = _app._getExperimentationContext().id;
      const before = JSON.stringify(_app.simulation.brushData);
      _app.experimentation.selectTab('starters');
      [...document.querySelectorAll('#experimentationContent button')].find(b => b.textContent === 'Add saved configuration').click();
      window.__starterId = _app.experimentation.selectedId;
      _app._addExperimentationStarter('obstacle');
      return {same: before === JSON.stringify(_app.simulation.brushData), index: _app.simulation.activeSessionIndex,
        unarmed: _app.simulation.multiSessionBindings.every(b => !b.enabled)};
    })()`);
    assert.deepEqual(result, { same: true, index: -1, unarmed: true });
    await evaluate(`document.querySelector('[data-direction="1"]').click()`);
    assert.equal(await evaluate(`_app.simulation.activeSessionIndex`), -1);
    await evaluate(`document.querySelector('[data-direction="-1"]').click()`);
    // Exercise the actual confirmation handler, then accept via CDP.
    const click = evaluate(`document.querySelector('#experimentationContent .experiment-card > button').click()`);
    await delay(100);
    await send('Page.handleJavaScriptDialog', { accept: true });
    await click;
    assert.equal(await evaluate(`_app.simulation.sessions[_app.simulation.activeSessionIndex].id === __starterId`), true);
    assert.equal(await evaluate(`_app.simulation.sessions.some(s => s.id === __draftId)`), true);
    assert.equal(await evaluate(`_app.experimentation.store.records.has(__draftId)`), true);
    assert.equal(await evaluate(`_app.simulation.running`), false);
    assert.equal(await evaluate(`JSON.stringify(__beforePaint) === JSON.stringify(_app.layers.map(l => l.canvas.toDataURL()))`), true);
    // External session loading must retarget Current, not keep editing the old card.
    await evaluate(`(() => {
      _app.experimentation.selectTab('current');
      const index = _app.simulation.sessions.findIndex(s => s.id === __draftId);
      _app._setActiveSimulationSessionIndex(index);
    })()`);
    assert.equal(await evaluate(`_app.experimentation.context().id === __draftId`), true);
    assert.match(await evaluate(`document.querySelectorAll('.experiment-question')[1].querySelector('textarea').value`), /observation/);
  });

  await t.test('dialog tabs support arrows and remain non-modal while protecting painting shortcuts', async () => {
    await evaluate(`document.getElementById('experimentationTabCurrent').focus()`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'ArrowRight', code: 'ArrowRight' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'ArrowRight', code: 'ArrowRight' });
    assert.equal(await evaluate(`document.activeElement.id`), 'experimentationTabSaved');
    assert.equal(await evaluate(`document.activeElement.getAttribute('aria-selected')`), 'true');
    assert.equal(await evaluate(`document.getElementById('experimentationDialog').getAttribute('aria-modal')`), 'false');
    const count = await evaluate(`_app.simulation.sessions.length`);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete', code: 'Delete' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete', code: 'Delete' });
    assert.equal(await evaluate(`_app.simulation.sessions.length`), count);
    await evaluate(`document.getElementById('simRunBtn').focus()`);
    assert.equal(await evaluate(`document.activeElement.id`), 'simRunBtn');
    await evaluate(`_app.experimentation.selectTab('current')`);
  });

  await t.test('all starters actually run through the existing simulation engine', async () => {
    for (const key of ['flock', 'spacing', 'obstacle']) {
      const result = await evaluate(`(async () => {
        const session = _app._addExperimentationStarter(${JSON.stringify(key)});
        _app._loadExperimentationSession(session.id);
        await _app.startSimulation({announce:false});
        for (let n=0;n<20 && !_app.simulation.frameCount;n++) await new Promise(resolve => setTimeout(resolve, 100));
        const result = {running:_app.simulation.running, frames:_app.simulation.frameCount, count:_app.getP().count};
        _app.pauseSimulation();
        _app.stopSimulation(false);
        return result;
      })()`);
      assert.equal(result.running, true, key);
      assert.ok(result.frames > 0, `${key}: ${JSON.stringify(result)}`);
      assert.equal(result.count, 48);
    }
  });

  await t.test('saved Boid A edited as Ant returns with Ant controls, guides, and engine after loading B', async () => {
    const result = await evaluate(`(() => {
      const app = _app;
      const alpha = document.getElementById('showAlphaFeatures');
      const priorAlpha = alpha.checked;
      alpha.checked = true;
      app.setAlphaFeaturesVisible(true, {persist:false});
      try {
        const a = app._addExperimentationStarter('flock');
        const b = app._addExperimentationStarter('spacing');
        app._loadExperimentationSession(a.id);
        app.setBrush('ant');
        const count = document.getElementById('count');
        count.value = '73';
        count.dispatchEvent(new Event('input', {bubbles:true}));
        app.simulation.brushData.ant.spawns[0].x = app.W * 0.37;
        // Compare normalized data; newly created spawns gain color/mask defaults on load.
        app._normalizeSimulationData();
        const guides = structuredClone(app.simulation.brushData.ant);
        // The starter's mode-transition autosave must still capture A as Ant.
        app._setSimulationMode('forceVisualization');
        app._loadExperimentationSession(b.id);
        const storedBrush = app.simulation.sessions.find(s => s.id === a.id).experimentationBrush;
        app._loadExperimentationSession(a.id);
        return {storedBrush, activeBrush:app.activeBrush, antEngine:app.getCurrentBrush() === app.brushes.ant,
          count:app.getP().count, guides, loadedGuides:app.simulation.brushData.ant};
      } finally {
        app.setBrush('boid');
        alpha.checked = priorAlpha;
        app.setAlphaFeaturesVisible(priorAlpha, {persist:false});
      }
    })()`);
    assert.deepEqual(result.loadedGuides, result.guides);
    assert.deepEqual(
      { storedBrush: result.storedBrush, activeBrush: result.activeBrush, antEngine: result.antEngine, count: result.count },
      { storedBrush: 'ant', activeBrush: 'ant', antEngine: true, count: 73 },
    );
  });

  await t.test('loading a starter from force-viz keeps the rotated document inside the reserved viewport', async () => {
    const result = await evaluate(`(() => {
      const app = _app;
      app.experimentation.close();
      const before = app._captureViewState();
      const paint = app.layers.map(l => l.canvas.toDataURL());
      app._applyViewState({zoom:2.2, panX:183, panY:-92, rotation:0.4, flipped:true});
      app._setSimulationMode('forceVisualization');
      app.simulation.forceViz.camera.exitBehavior = 'restoreManualView';
      const saved = app._captureViewState();
      app.experimentation.show();
      const fitted = app._captureViewState();
      const session = app._addExperimentationStarter('flock');
      app._loadExperimentationSession(session.id);
      const afterLoad = app._captureViewState();
      const metrics = app._getCanvasViewMetrics();
      const c = Math.abs(Math.cos(app.viewRotation)), s = Math.abs(Math.sin(app.viewRotation));
      const inside = (metrics.docW*c + metrics.docH*s)*app.viewZoom <= metrics.areaRect.width
        && (metrics.docW*s + metrics.docH*c)*app.viewZoom <= metrics.areaRect.height;
      app.experimentation.close();
      const closed = app._captureViewState();
      const samePaint = JSON.stringify(paint) === JSON.stringify(app.layers.map(l => l.canvas.toDataURL()));
      app._applyViewState(before);
      app.experimentation.show();
      return {saved, fitted, afterLoad, inside, closed, samePaint, mode:app.simulation.mode};
    })()`);
    assert.deepEqual(result.afterLoad, result.fitted);
    assert.equal(result.inside, true);
    assert.deepEqual(result.closed, result.saved);
    assert.equal(result.samePaint, true);
    assert.equal(result.mode, 'normal');
  });

  await t.test('closing preserves prior force-viz exit semantics without leaking the temporary fit', async () => {
    const results = await evaluate(`(() => {
      const app = _app;
      app.experimentation.close();
      const before = app._captureViewState();
      const results = [];
      for (const enteredBefore of [true, false]) {
        for (const exitBehavior of ['restoreManualView', 'retainCurrentView']) {
          app._applyViewState({zoom:1.8, panX:123, panY:-47, rotation:0.2, flipped:true});
          const manual = app._captureViewState();
          if (enteredBefore) {
            app._setSimulationMode('forceVisualization');
            app._applyViewState({...manual, zoom:0.9, panX:-87});
          }
          const saved = app._captureViewState();
          app.experimentation.show();
          if (!enteredBefore) app._setSimulationMode('forceVisualization');
          app.simulation.forceViz.camera.exitBehavior = exitBehavior;
          const fitted = app._captureViewState();
          app._applyViewState(saved);
          app._toggleSimulationMode(false);
          const disabledView = app._captureViewState();
          app._applyViewState(saved);
          app._toggleSimulationMode(true);
          const enabledView = app._captureViewState();
          app.experimentation.close();
          const closed = app._captureViewState();
          app._setSimulationMode('normal');
          results.push({enteredBefore, exitBehavior, manual, saved, fitted, disabledView, enabledView, closed, afterExit:app._captureViewState(),
            snapshot:app._forceVizManualViewSnapshot});
        }
      }
      app._applyViewState(before);
      app.experimentation.show();
      return results;
    })()`);
    for (const result of results) {
      const label = `${result.enteredBefore ? 'pre-existing' : 'new'} / ${result.exitBehavior}`;
      assert.deepEqual(result.disabledView, result.fitted, label);
      assert.deepEqual(result.enabledView, result.fitted, label);
      assert.deepEqual(result.closed, result.saved, label);
      assert.deepEqual(result.afterExit, result.exitBehavior === 'restoreManualView' ? result.manual : result.saved, label);
      assert.equal(result.snapshot, null, label);
    }
  });

  await t.test('desktop/tablet/phone reserve 40%, scroll without horizontal overflow, and retain backing dimensions', async () => {
    await evaluate(`_app.experimentation.selectTab('current')`);
    const dimensions = await evaluate(`[ _app.W, _app.H, ..._app.layers.flatMap(l => [l.canvas.width,l.canvas.height]) ]`);
    for (const [width, height] of [[1024, 768], [768, 1024], [390, 844]]) {
      await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
      await delay(150);
      const layout = await evaluate(`(() => {
        const content = document.getElementById('experimentationContent');
        const area = document.getElementById('canvasArea').getBoundingClientRect();
        const dialog = document.getElementById('experimentationDialog').getBoundingClientRect();
        return {right:area.right,left:dialog.left,width:dialog.width,overflow:content.scrollWidth-content.clientWidth,
          dimensions:[_app.W,_app.H,..._app.layers.flatMap(l=>[l.canvas.width,l.canvas.height])]};
      })()`);
      assert.ok(Math.abs(layout.right - layout.left) < 1);
      assert.ok(Math.abs(layout.width - width * .4) < 1);
      assert.ok(layout.overflow <= 1, `${width}px overflow: ${layout.overflow}`);
      assert.deepEqual(layout.dimensions, dimensions);
    }
  });

  await t.test('feedback and session IDs survive reload, export remains valid, restored view is not the temporary fit', async () => {
    await evaluate(`(async () => {
      const app = _app;
      app._setActiveSimulationSessionIndex(app.simulation.sessions.findIndex(s => s.id === __draftId));
      app.simulation.sessions[app.simulation.activeSessionIndex].name = '<svg onload=alert(1)> Renamed';
      app._syncSimulationSessionContextUi();
      app.saveSession();
      app._downloadBlob = blob => {
        window.__exportPromise = blob.text().then(raw => { window.__exportedFeedback = JSON.parse(raw); });
      };
      document.getElementById('experimentationExport').click();
      await window.__exportPromise;
    })()`);
    assert.equal(await evaluate(`__exportedFeedback.format`), 'boid-brush-experimentation');
    assert.equal(await evaluate(`document.querySelectorAll('#experimentationContent svg[onload]').length`), 0);
    const id = await evaluate(`__draftId`);
    const expectedView = await evaluate(`_app.experimentation.savedView`);
    await evaluate(`window.__testReady = null`);
    await send('Page.reload');
    for (let n = 0; n < 300; n++) {
      if (await evaluate(`window.__testReady === 'Ready' && !!window._app?.experimentation`).catch(() => false)) break;
      await delay(100);
    }
    assert.equal(await evaluate(`_app.experimentation.open`), false);
    assert.equal(await evaluate(`_app._getExperimentationContext().id`), id);
    assert.deepEqual(await evaluate(`_app._captureViewState()`), expectedView);
    assert.equal(await evaluate(`_app.experimentation.store.records.get(${JSON.stringify(id)}).answers.alignment.notApplicable`), true);
  });
  await t.test('advanced river UI remains available and its real runner cancels promptly', async () => {
    await evaluate(`(async () => {
      const app=_app;
      await app.resizeDocument(400,400,'#ffffff');
      app._toggleSimulationMode(true);app.experimentation.show();app.experimentation.selectTab('starters');
      const bundleModule=await import('./river-experiment.js');
      const bundle=bundleModule.createRiverBundle({width:app.W,height:app.H,controls:app._getExperimentationDefaultControls()});
      window.__shortRiverLayerIds = app.layers.map(layer => layer.id);
      window.__shortRiver = app.experimentation.river.start(bundle);
      app.experimentation.river.cancel();
    })()`);
    for (let n = 0; n < 60 && await evaluate(`_app.experimentation.river.running`); n++) await delay(100);
    assert.equal(await evaluate(`_app.experimentation.river.running`), false);
    assert.match(await evaluate(`_app.experimentation.river.progress`), /Cancelled/);
    assert.equal(await evaluate(`!!document.querySelector('[data-river-start]')`), true);
    // Cancellation intentionally retains experiment paint. Undo this test's run
    // so the preexisting river tests do not inherit its extra visible layer.
    assert.equal(await evaluate(`(() => {
      _app.doUndo();
      return JSON.stringify(_app.layers.map(layer => layer.id)) === JSON.stringify(__shortRiverLayerIds);
    })()`), true, 'Short cancellation test restores its original layers');
    await evaluate(`_app.experimentation.close()`);
  });
  await t.test('river native sequence completes or times out safely with real outflow, paint and restoration', async () => {
    // Keep software presentation inexpensive without changing the production
    // 500-agent trials, fixed simulation step, guide speeds, or time budgets.
    await send('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await evaluate(`(async () => {
      const app = _app;
      if (app.simulation.running) app.pauseSimulation();
      if (app.simulation.paused) app.stopSimulation(false);
      app._workspaceMargin = 0;
      await app.resizeDocument(400, 400, '#ffffff');
      app._toggleSimulationMode(true);
      app.experimentation.show();
      app.experimentation.selectTab('starters');
      window.__riverModule = await import('./river-experiment.js');
      const bundle = __riverModule.createRiverBundle({
        width: app.W, height: app.H, controls: app._getExperimentationDefaultControls(), idPrefix: 'roundtrip-test'
      });
      const draft = app._simulationSetupDraft;
      const saved = JSON.stringify(app.simulation.sessions);
      await app.importSimulationSetupText(JSON.stringify(bundle));
      window.__riverImport = {
        count: app._simulationSetupDraft.sessions.length,
        sameSaved: JSON.stringify(app.simulation.sessions) === saved,
        ids: app._simulationSetupDraft.sessions.map(s => s.id),
        enabled: app._simulationSetupDraft.rows.map(r => r.enabled),
        normalized: app._normalizeSimulationSetupBundle(bundle).sessions,
        originals: bundle.sessions
      };
      app._simulationSetupDraft = draft;
      app._downloadBlob = blob => {
        window.__riverDownload = blob.text().then(raw => JSON.parse(raw));
      };
      [...app.experimentation.body.querySelectorAll('button')].find(b => b.textContent === 'Download native river JSON').click();
      window.__riverDownloaded = await __riverDownload;
      const mod = await import('./boid-input-modulation.js?v=2026-09-10-edge-overlay-cache-bust');
      document.getElementById('boidModMatrix').value = JSON.stringify({
        format: mod.MOD_MATRIX_FORMAT, version: mod.MOD_MATRIX_VERSION,
        routes: [mod.createModRoute({source:'pressure', target:'cohesion', amount:.5}, 0)], channels:{}
      });
      app._restoreSensingSourceSelection([app.getActiveLayer().id]);
      app.getActiveLayer().alphaLock=true;
      app.setTool('fill');
      app.invalidateParams();
      window.__riverBefore = {
        controls: app._captureSimulationSessionControlState(),
        sessions: JSON.stringify(app.simulation.sessions),
        bindings: JSON.stringify(app.simulation.multiSessionBindings),
        brushData: JSON.stringify(app.simulation.brushData),
        vars: JSON.stringify(app.simulation.vars),
        active: app.simulation.activeSessionIndex, brush: app.activeBrush,
        layerId: app.getActiveLayer().id,
        layers: app.layers.map(l => ({id:l.id, paint:l.canvas.toDataURL(), visible:l.visible, alphaLock:l.alphaLock})),
        view: app._captureViewState(), draftId: app.simulation.experimentationDraftId,
        playback: JSON.stringify(app.simulation.savedPlayback),
        tool: app.activeTool, sensing: JSON.stringify(app._serializeSensingSourceSelection()),
        undo: app.undoStack.length
      };
      window.confirm = () => true;
      document.querySelector('[data-river-start]').click();
    })()`);
    const imported = await evaluate(`__riverImport`);
    assert.equal(imported.count, 9);
    assert.equal(imported.sameSaved, true);
    assert.ok(imported.enabled.every(v => !v));
    assert.deepEqual(imported.normalized, imported.originals);
    assert.equal(await evaluate(`__riverDownloaded.riverExperiment.analysis.baseline.seek`), 0);
    assert.equal(await evaluate(`_app.experimentation.river.running`), true);

    const positionHashes = new Set(), paintHashes = new Set(), backends = new Set();
    let maxAgents = 0, maxOutside = 0, maxX = 0, maxFrame = 0;
    const shots = new Set();
    for (let n = 0; n < 1450; n++) {
      const sample = await evaluate(`(() => {
        const app = _app, run = app.experimentation.river, brush = app.getCurrentBrush();
        const read = brush.sim?.readAgents?.() || {count:0,buffer:[],stride:1};
        let hash = 0, outside = 0, maxX = 0;
        for(let i=0; i<read.count; i++) {
          const x=read.buffer[i*read.stride], y=read.buffer[i*read.stride+1];
          hash += x*(i+1) + y;
          if(x>app.W || x<0 || y<0 || y>app.H) outside++;
          maxX=Math.max(maxX,x);
        }
        const layer = app.getActiveLayer();
        const canvas = document.createElement('canvas'); canvas.width=128;canvas.height=128;
        const ctx=canvas.getContext('2d');
        ctx.drawImage(layer.canvas,0,0,128,128);
        if(layer.gpuPreviewCanvas) ctx.drawImage(layer.gpuPreviewCanvas,0,0,128,128);
        const pixels=ctx.getImageData(0,0,128,128).data;
        let paint=0;for(let i=3;i<pixels.length;i+=4) paint+=pixels[i];
        const path=app.simulation.brushData.boid?.paths?.[0];
        const p=app.getP();
        return {running:run.running,progress:run.progress,results:run.results,
          frame:app.simulation.frameCount,count:read.count,hash,paint,outside,maxX,
          layer:layer.name,backend:brush.getStatusInfo?.(),
          travel:path?.travelDistance||0, length:path?app._getSimulationPathSample(path,0).totalLength:0,
          points:path?.points.length, effective:{maxSpeed:p.maxSpeed,wander:p.wander,seek:p.seek,
            stampSize:p.stampSize,mod:p.modMatrix,stampImage:!!p.stampImageCanvas,simPathSpeed:p.simPathSpeed}
        };
      })()`);
      if (!sample.running) break;
      assert.ok(Number.isFinite(sample.hash), JSON.stringify(sample));
      maxAgents = Math.max(maxAgents, sample.count);
      maxOutside = Math.max(maxOutside, sample.outside);
      maxX = Math.max(maxX, sample.maxX);
      maxFrame = Math.max(maxFrame, sample.frame);
      positionHashes.add(Math.round(sample.hash));
      paintHashes.add(sample.paint);
      backends.add(sample.backend);
      assert.equal(sample.effective.seek, 0);
      assert.equal(sample.effective.stampImage, false);
      if (sample.layer === 'River · Guided baseline') {
        assert.equal(sample.effective.maxSpeed, 11);
        assert.equal(sample.effective.wander, .06);
        assert.equal(sample.effective.simPathSpeed, 56);
        assert.equal(sample.effective.mod.routes.length, 0);
        const phase = sample.progress.includes('bypass') ? 'bypass' : 'horseshoe';
        if (sample.travel / sample.length > .25 && !shots.has(phase)) {
          const screenshot = await send('Page.captureScreenshot', { format: 'png' });
          await writeFile(join(tmpdir(), `boid-river-${phase}.png`), Buffer.from(screenshot.data, 'base64'));
          shots.add(phase);
        }
      }
      await delay(500);
    }
    const result = await evaluate(`(() => {
      const app=_app, before=__riverBefore, run=app.experimentation.river;
      return {running:run.running, progress:run.progress, results:run.results,
        restored: {
          controls: JSON.stringify(app._captureSimulationSessionControlState())===JSON.stringify(before.controls),
          sessions: JSON.stringify(app.simulation.sessions.slice(0,-9))===before.sessions,
          bindings: JSON.stringify(app.simulation.multiSessionBindings.slice(0,-9))===before.bindings,
          brushData: JSON.stringify(app.simulation.brushData)===before.brushData,
          vars: JSON.stringify(app.simulation.vars)===before.vars,
          layer: app.getActiveLayer().id===before.layerId,
          paint: before.layers.every(old=>app.layers.find(l=>l.id===old.id).canvas.toDataURL()===old.paint),
          visibility:before.layers.every(old=>app.layers.find(l=>l.id===old.id).visible===old.visible),
          view:JSON.stringify(app._captureViewState())===JSON.stringify(before.view),
          draftId:app.simulation.experimentationDraftId===before.draftId,
          playback:JSON.stringify(app.simulation.savedPlayback)===before.playback,
          stopped:!app.simulation.running&&!app.simulation.paused,
          active:app.simulation.activeSessionIndex===before.active,
          brush:app.activeBrush===before.brush,
          tool:app.activeTool===before.tool,
          sensing:JSON.stringify(app._serializeSensingSourceSelection())===before.sensing,
          undo:app.undoStack.length===Math.min(20,before.undo+1),
        },
        unarmed:app.simulation.multiSessionBindings.slice(-9).every(b=>!b.enabled),
        newLayers:app.layers.filter(l=>l.name.startsWith('River ·')).map(l=>{
          const data=l.ctx.getImageData(0,0,l.canvas.width,l.canvas.height).data;
          let paint=0;for(let i=3;i<data.length;i+=4)paint+=data[i];
          return {name:l.name,visible:l.visible,paint};
        })
      };
    })()`);
    t.diagnostic(JSON.stringify({ maxAgents, maxOutside, maxX, maxFrame,
      positionSamples: positionHashes.size, paintSamples: paintHashes.size,
      backends: [...backends], result }));
    assert.equal(result.running, false, result.progress);
    // A fixed-step circuit cannot finish within the declared wall-clock budget
    // on every software renderer. Timeout is an intentional production outcome,
    // not permission to accelerate guides with app uptime or relax the limits.
    assert.match(result.progress, /^(Finished\.|Stopped: Time budget reached\.)/);
    assert.ok(result.results.length >= 1 && result.results.length <= 9, result.progress);
    if (result.progress.startsWith('Finished')) assert.equal(result.results.length, 9);
    assert.ok(Object.values(result.restored).every(Boolean), JSON.stringify(result.restored));
    assert.equal(result.unarmed, true);
    assert.ok(result.newLayers.length >= 2 && result.newLayers.length <= 5);
    assert.ok(result.newLayers.every(l => l.paint > 0), JSON.stringify(result.newLayers));
    assert.equal(result.newLayers.filter(l => l.visible).length, 1);
    assert.equal(maxAgents, 500);
    assert.ok(positionHashes.size > 10);
    assert.ok(paintHashes.size > 10);
    assert.ok(maxOutside > 0 && maxX > 400, 'Actual agents must cross the right outlet, not only the guide');
    assert.ok(shots.has('horseshoe'));
    if (result.results.some(r => r.phase === 'bypass')) assert.ok(shots.has('bypass'));
    // Per-session observations remain distinct after appending generated IDs.
    assert.equal(await evaluate(`(() => {
      const app=_app, sessions=app.simulation.sessions.slice(-9);
      app.experimentation.store.update(app._getExperimentationContext(sessions[1]), {notes:'horseshoe observed'});
      app.experimentation.store.update(app._getExperimentationContext(sessions[2]), {notes:'bypass observed'});
      return app.experimentation.store.records.get(sessions[1].id).notes !== app.experimentation.store.records.get(sessions[2].id).notes;
    })()`), true);
    assert.equal(await evaluate(`(() => {
      const app=_app, before=__riverBefore, candidates=app.simulation.sessions.length;
      const layerCount=app.layers.length;
      app.doUndo();
      const restored=app.layers.length===before.layers.length
        && before.layers.every((old,i)=>app.layers[i].id===old.id && app.layers[i].canvas.toDataURL()===old.paint
          && app.layers[i].alphaLock===old.alphaLock)
        && app.getActiveLayer().id===before.layerId
        && JSON.stringify(app.simulation.brushData)===before.brushData
        && app.simulation.sessions.length===candidates;
      app.doRedo();
      return restored && app.layers.length===layerCount
        && JSON.stringify(app.simulation.brushData)===before.brushData;
    })()`), true, 'Undo/redo must remove/restore experiment layers, never temporary guides or saved candidates');
  });

  await t.test('all nine river transitions retain agents and layers with explicitly shortened guide milestones', async () => {
    await evaluate(`(() => {
      const app=_app, runner=app.experimentation.river;
      const wait=runner.waitForPhase, start=app.startSimulation;
      const beforeLayers=app.layers.length;
      window.__milestones={done:false, starts:0, phases:[]};
      app.startSimulation=function(...args) { __milestones.starts++; return start.apply(this,args); };
      runner.waitForPhase=async function(session, started) {
        // Test fixture only: render real frames, then skip the remainder of the
        // guide circuit. This validates scheduling, not full horseshoe visuals.
        if (session.riverExperiment.phase!=='control') {
          await new Promise(resolve=>setTimeout(resolve,300));
          const path=app.simulation.brushData.boid.paths[0];
          if (JSON.stringify(path.points)!==JSON.stringify(session.brushData.boid.paths[0].points)) {
            throw new Error('Wrong phase geometry');
          }
          path.travelDistance=app._getSimulationPathSample(path,0).totalLength;
        }
        __milestones.phases.push({
          trial:session.riverExperiment.trial, phase:session.riverExperiment.phase,
          layer:app.getActiveLayer().id, frame:app.simulation.frameCount,
          count:app.getCurrentBrush().sim.readAgents().count
        });
        return wait.call(this,session,started);
      };
      const bundle=__riverModule.createRiverBundle({
        width:app.W,height:app.H,controls:app._getExperimentationDefaultControls(),
        idPrefix:'shortened-milestones'
      });
      runner.start(bundle).then(ok=>{
        __milestones.ok=ok;
        __milestones.progress=runner.progress;
        __milestones.layers=app.layers.length-beforeLayers;
        __milestones.completed=runner.results.length;
      }).finally(()=>{
        runner.waitForPhase=wait;
        app.startSimulation=start;
        __milestones.done=true;
      });
    })()`);
    for (let n=0; n<120 && !await evaluate(`__milestones.done`); n++) await delay(500);
    const result=await evaluate(`__milestones`);
    assert.equal(result.done,true);
    assert.equal(result.ok,true,result.progress);
    assert.equal(result.starts,5);
    assert.equal(result.completed,9);
    assert.equal(result.layers,5);
    assert.ok(result.phases.every(p=>p.count===500));
    for (let i=1;i<9;i+=2) {
      const horseshoe=result.phases[i], bypass=result.phases[i+1];
      assert.equal(horseshoe.phase,'horseshoe');
      assert.equal(bypass.phase,'bypass');
      assert.equal(bypass.layer,horseshoe.layer);
      assert.ok(bypass.frame>horseshoe.frame,'bypass must continue, not restart, playback');
    }
  });

  await t.test('river Escape cancels real playback and removes the input fence', async () => {
    await evaluate(`(async () => {
      const app=_app;
      document.getElementById('showAlphaFeatures').checked=true;
      app.setAlphaFeaturesVisible(true, {persist:false});
      app.setBrush('ant');
      app.simulation.editorTool='edge';
      app._setSimulationMode('forceVisualization');
      await app.startSimulation({announce:false});
      window.__cancelBefore = {
        brush:app.activeBrush, mode:app.simulation.mode, tool:app.simulation.editorTool,
        controls:JSON.stringify(app._captureSimulationSessionControlState()),
        sensing:JSON.stringify(app._serializeSensingSourceSelection()),
        data:JSON.stringify(app.simulation.brushData),
        paint:app.layers.map(l=>({id:l.id,paint:l.canvas.toDataURL()})),
        camera:JSON.stringify(app._forceVizCameraRuntime),
        manual:JSON.stringify(app._forceVizManualViewSnapshot)
      };
      document.querySelector('[data-river-start]').click();
    })()`);
    assert.equal(await evaluate(`_app.experimentation.river.running`), true);
    assert.equal(await evaluate(`__cancelBefore.brush`), 'ant');
    await delay(700);
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' });
    await delay(500);
    assert.equal(await evaluate(`_app.experimentation.river.running`), false);
    assert.match(await evaluate(`_app.experimentation.river.progress`), /Cancelled/);
    assert.equal(await evaluate(`_app.simulation.running || _app.simulation.paused`), false);
    assert.equal(await evaluate(`(() => {
      const app=_app, before=__cancelBefore;
      return app.activeBrush===before.brush && app.simulation.mode===before.mode
        && app.simulation.editorTool===before.tool
        && JSON.stringify(app._captureSimulationSessionControlState())===before.controls
        && JSON.stringify(app._serializeSensingSourceSelection())===before.sensing
        && JSON.stringify(app.simulation.brushData)===before.data
        && before.paint.every(old=>app.layers.find(l=>l.id===old.id).canvas.toDataURL()===old.paint)
        && JSON.stringify(app._forceVizCameraRuntime)===before.camera
        && JSON.stringify(app._forceVizManualViewSnapshot)===before.manual;
    })()`), true, 'Cancellation restores non-boid running workspace without committing its preview');
    await evaluate(`document.getElementById('experimentationClose').click()`);
    assert.equal(await evaluate(`_app.experimentation.open`), false);
  });
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions');
});
