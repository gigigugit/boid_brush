// ui-components/layers/LayersPanel.js

export function createLayersPanel(container) {
    if (!container) return;

    container.innerHTML = `
        <div class="layers-panel">

            <div class="section-header" data-section="layers">
                Layers <span class="chevron">▼</span>
            </div>

            <div class="section-body">

                <div class="layer-actions">
                    <button id="btnAddLayer">+ Add</button>
                    <button id="btnDupLayer">⧉ Dup</button>
                    <button id="btnDelLayer">✕ Del</button>
                    <button id="btnFlatten">Flatten</button>
                    <button id="btnMergeDown">Merge▼</button>
                    <button id="btnLayerUp">▲</button>
                    <button id="btnLayerDown">▼</button>
                </div>

                <div class="blend-row">

                    <label>
                        Blend
                        <select id="layerBlend">
                            <option value="source-over">Normal</option>
                            <option value="multiply">Multiply</option>
                            <option value="screen">Screen</option>
                            <option value="overlay">Overlay</option>
                            <option value="darken">Darken</option>
                            <option value="lighten">Lighten</option>
                            <option value="add">Add</option>
                            <option value="color-dodge">Dodge</option>
                            <option value="color-burn">Burn</option>
                            <option value="hard-light">Hard Light</option>
                            <option value="soft-light">Soft Light</option>
                            <option value="difference">Difference</option>
                            <option value="exclusion">Exclusion</option>
                            <option value="hue">Hue</option>
                            <option value="saturation">Saturation</option>
                            <option value="color">Color</option>
                            <option value="luminosity">Luminosity</option>
                        </select>
                    </label>

                    <label>
                        Opacity
                        <span id="v_layerOpacity">50</span>%
                        <input
                            type="range"
                            id="layerOpacity"
                            min="0"
                            max="100"
                            value="50"
                        >
                    </label>

                </div>

                <div id="layerList"></div>

            </div>

        </div>
    `;
}