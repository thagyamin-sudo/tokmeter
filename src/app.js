import { applyUnit } from './units.js';

const panel = document.getElementById('panel');

/** 面板宽度决定 1u 的像素值，窗口尺寸变化时重算。 */
function layout() {
  applyUnit(panel, panel.clientWidth);
}

layout();
addEventListener('resize', layout);
addEventListener('orientationchange', layout);
