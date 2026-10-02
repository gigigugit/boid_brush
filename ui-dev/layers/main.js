// ============================================================
// Boid Brush — Layers Panel Preview
// ui-dev/layers/main.js
// ============================================================

import { createLayersPanel } from '../../ui-components/layers/LayersPanel.js';


// ------------------------------------------------------------
// Find preview container
// ------------------------------------------------------------

const container = document.getElementById('app');

if (!container) {
    throw new Error('Layers preview container #app was not found.');
}


// ------------------------------------------------------------
// Render Layers component
// ------------------------------------------------------------

createLayersPanel(container);