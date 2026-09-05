// 时间口径统一工具（2026-09-05 时间 P1）
//
// 存储约定：
//   - 任务域机器时刻（pickup_tasks / pickup_items / task_events /
//     task_exceptions / task_assistants / pickup_photos）一律存 UTC 空格文本
//     'YYYY-MM-DD HH:mm:ss'（由 utcText() 生成）。
//   - 用户录入的计划时刻（scheduled_time / rush_ship_time）为北京时间钟面文本，
//     不做时区换算，只与北京 now 比较。
//   - 旧业务模块（operation_logs / records / waybill_weights 等）保持北京时间
//     空格文本自洽；通知模块保持 ISO8601 Z。
//
// 展示约定：
//   - v1（Web 老接口）把任务域 UTC 文本转换为北京时间文本后返回，页面原样显示。
//   - v2（移动端）把任务域 UTC 文本转 ISO8601 Z 输出（见 http/api-v2.js toIso）。
const TIME_TEXT_RE = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;

function toText(date) {
  return date.toISOString().replace('T', ' ').slice(0, 19);
}

// 当前 UTC 时刻的空格文本（任务域存储唯一写入口语义）
function utcText(date = new Date()) {
  return toText(date);
}

// 当前北京时间钟面空格文本（旧业务模块与录入列展示口径）
function bjText(date = new Date()) {
  return toText(new Date(date.getTime() + 8 * 3600 * 1000));
}

// 北京时间日期戳 YYYYMMDD（任务号前缀等面向业务的日期）
function bjDateStamp(date = new Date()) {
  return bjText(date).slice(0, 10).replaceAll('-', '');
}

function isTimeText(value) {
  return typeof value === 'string' && TIME_TEXT_RE.test(value);
}

function shiftText(text, hours) {
  if (!isTimeText(text)) return text;
  const [datePart, timePart] = text.split(' ');
  const [y, mo, dd] = datePart.split('-').map(Number);
  const [h, mi, s] = timePart.split(':').map(Number);
  return toText(new Date(Date.UTC(y, mo - 1, dd, h + hours, mi, s)));
}

// UTC 空格文本 -> 北京时间空格文本（v1 展示用；非时间文本原样返回）
function utcTextToBjText(text) {
  return shiftText(text, 8);
}

// 北京时间空格文本 -> UTC 空格文本（历史错写修正/迁移用）
function bjTextToUtcText(text) {
  return shiftText(text, -8);
}

module.exports = { utcText, bjText, bjDateStamp, isTimeText, shiftText, utcTextToBjText, bjTextToUtcText, TIME_TEXT_RE };
