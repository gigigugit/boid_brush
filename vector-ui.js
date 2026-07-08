function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function options(current, items) {
  return items.map(item => `<option value="${item.value}"${item.value === current ? ' selected' : ''}>${esc(item.label)}</option>`).join('');
}

export function buildVectorSidebar() {
  const sidebar = document.getElementById('vectorSidebar');
  sidebar.innerHTML = `
    <div class="panel-section">
      <div class="panel-section-title">Document</div>
      <div class="panel-stack">
        <label class="field">
          <span>Width</span>
          <input id="docWidth" type="number" min="1" step="1" value="1600">
        </label>
        <label class="field">
          <span>Height</span>
          <input id="docHeight" type="number" min="1" step="1" value="900">
        </label>
        <label class="field">
          <span>Background</span>
          <input id="docBackground" type="color" value="#10141d">
        </label>
        <div class="button-row">
          <button id="saveLocalBtn" type="button">Save Local</button>
          <button id="loadLocalBtn" type="button">Load Local</button>
        </div>
        <div class="button-row">
          <button id="saveJsonBtn" type="button">Download JSON</button>
          <button id="openJsonBtn" type="button">Open JSON</button>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">Defaults</div>
      <div class="panel-stack">
        <label class="field">
          <span>Fill</span>
          <input id="defaultFill" type="color" value="#5b8af0">
        </label>
        <label class="field">
          <span>Stroke</span>
          <input id="defaultStroke" type="color" value="#e8edf8">
        </label>
        <label class="field">
          <span>Stroke Width</span>
          <input id="defaultStrokeWidth" type="number" min="1" step="1" value="4">
        </label>
        <label class="field">
          <span>Opacity</span>
          <input id="defaultOpacity" type="range" min="0.05" max="1" step="0.05" value="1">
        </label>
        <div class="field-hint">These values seed new shapes and apply to the current selection when you adjust them.</div>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">Selection</div>
      <div class="panel-stack">
        <div class="summary-box" id="selectionSummary">No shape selected</div>
        <label class="field">
          <span>Guide Role</span>
          <select id="selectedGuideRole">
            ${options('none', [
              { value: 'none', label: 'None' },
              { value: 'path', label: 'Path Guide' },
              { value: 'spawn', label: 'Spawn Region' },
              { value: 'barrier', label: 'Barrier' },
              { value: 'attractor', label: 'Attractor' },
            ])}
          </select>
        </label>
        <label class="field">
          <span>Fill</span>
          <input id="selectedFill" type="color" value="#5b8af0">
        </label>
        <label class="field">
          <span>Stroke</span>
          <input id="selectedStroke" type="color" value="#e8edf8">
        </label>
        <label class="field">
          <span>Stroke Width</span>
          <input id="selectedStrokeWidth" type="number" min="1" step="1" value="4">
        </label>
        <label class="field">
          <span>Opacity</span>
          <input id="selectedOpacity" type="range" min="0.05" max="1" step="0.05" value="1">
        </label>
        <div class="button-row">
          <button id="duplicateShapeBtn" type="button">Duplicate</button>
          <button id="deleteShapeBtn" type="button">Delete</button>
        </div>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">Scene Items</div>
      <div class="panel-stack">
        <div class="button-row">
          <button id="moveShapeUpBtn" type="button">Move Up</button>
          <button id="moveShapeDownBtn" type="button">Move Down</button>
        </div>
        <div class="item-list" id="vectorItemList"></div>
      </div>
    </div>

    <div class="panel-section">
      <div class="panel-section-title">Iteration Notes</div>
      <div class="panel-stack">
        <div class="field-hint">This first page ships line, rectangle, ellipse, and polyline tools plus local copy/paste, JSON saves, and SVG export.</div>
        <div class="field-hint">The document model already tags shapes with simulation roles so paths and regions can map into the main app later.</div>
        <div class="field-hint">Curves, arcs, join, split, and boolean tools are intentionally deferred for later passes.</div>
      </div>
    </div>
  `;
}

export function syncVectorSidebar(app) {
  const docWidth = document.getElementById('docWidth');
  const docHeight = document.getElementById('docHeight');
  const docBackground = document.getElementById('docBackground');
  if (docWidth) docWidth.value = String(app.doc.width);
  if (docHeight) docHeight.value = String(app.doc.height);
  if (docBackground) docBackground.value = app.doc.background;

  const defaultFill = document.getElementById('defaultFill');
  const defaultStroke = document.getElementById('defaultStroke');
  const defaultStrokeWidth = document.getElementById('defaultStrokeWidth');
  const defaultOpacity = document.getElementById('defaultOpacity');
  if (defaultFill) defaultFill.value = app.state.defaults.fill;
  if (defaultStroke) defaultStroke.value = app.state.defaults.stroke;
  if (defaultStrokeWidth) defaultStrokeWidth.value = String(app.state.defaults.strokeWidth);
  if (defaultOpacity) defaultOpacity.value = String(app.state.defaults.opacity);

  const selected = app.getSelectedShape();
  const selectionSummary = document.getElementById('selectionSummary');
  const selectedGuideRole = document.getElementById('selectedGuideRole');
  const selectedFill = document.getElementById('selectedFill');
  const selectedStroke = document.getElementById('selectedStroke');
  const selectedStrokeWidth = document.getElementById('selectedStrokeWidth');
  const selectedOpacity = document.getElementById('selectedOpacity');
  const selectionDisabled = !selected;

  if (selectionSummary) {
    const selectionLabel = selected
      ? `${selected.kind} · ${selected.id.slice(0, 14)} · ${selected.meta.guideRole || 'none'}`
      : 'No shape selected';
    selectionSummary.textContent = selectionLabel;
  }
  if (selectedGuideRole) {
    selectedGuideRole.disabled = selectionDisabled;
    selectedGuideRole.value = selected?.meta.guideRole || 'none';
  }
  if (selectedFill) {
    selectedFill.disabled = selectionDisabled;
    selectedFill.value = selected?.style.fill && selected.style.fill !== 'none' ? selected.style.fill : '#000000';
  }
  if (selectedStroke) {
    selectedStroke.disabled = selectionDisabled;
    selectedStroke.value = selected?.style.stroke || '#e8edf8';
  }
  if (selectedStrokeWidth) {
    selectedStrokeWidth.disabled = selectionDisabled;
    selectedStrokeWidth.value = String(selected?.style.strokeWidth || app.state.defaults.strokeWidth);
  }
  if (selectedOpacity) {
    selectedOpacity.disabled = selectionDisabled;
    selectedOpacity.value = String(selected?.style.opacity || app.state.defaults.opacity);
  }

  ['duplicateShapeBtn', 'deleteShapeBtn', 'moveShapeUpBtn', 'moveShapeDownBtn'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.disabled = selectionDisabled;
  });

  const list = document.getElementById('vectorItemList');
  if (list) {
    list.innerHTML = app.doc.items.map((item, index) => {
      const active = item.id === selected?.id ? ' item-card-active' : '';
      return `
        <button class="item-card${active}" type="button" data-item-id="${item.id}">
          <span>${esc(item.kind)}</span>
          <span>${index + 1}</span>
        </button>
      `;
    }).reverse().join('');
  }
}
