// Optional real-browser regression, no npm dependencies:
// BB_TEST_CHROMIUM=/usr/bin/chromium node --test tests/experimentation-browser.test.js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { startStaticServer } = require('../electron/static-server.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

test('Experimentation real-browser layout, feedback, session, and input lifecycle', {
  skip: !process.env.BB_TEST_CHROMIUM,
  timeout: 180000,
}, async t => {
  const profile = await mkdtemp(join(tmpdir(), 'bb-experimentation-'));
  const server = await startStaticServer();
  const chrome = spawn(process.env.BB_TEST_CHROMIUM, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage',
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
      document.querySelector('#experimentationContent .experiment-card button').click();
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
        await new Promise(resolve => setTimeout(resolve, 150));
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
  assert.deepEqual(exceptions, [], 'No uncaught browser exceptions');
});
