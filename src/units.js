/**
 * 等比缩放单位：面板内所有尺寸都以 --u（面板宽度的 1%）为基准，
 * 这样面板在任何视口宽度下都保持与参考截图一致的比例。
 */

/** 返回面板宽度对应的 1u 像素值。 */
export function unitPx(panelWidth) {
  if (!Number.isFinite(panelWidth) || panelWidth <= 0) return 0;
  return panelWidth / 100;
}

/** 把 --u 写到元素上，返回写入的像素值。 */
export function applyUnit(el, width) {
  const u = unitPx(width);
  el.style.setProperty('--u', u + 'px');
  return u;
}
