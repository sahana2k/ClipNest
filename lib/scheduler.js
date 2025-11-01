// lib/scheduler.js

// Leitner boxes with simple day intervals:
const BOX_INTERVALS = [1, 2, 4, 8, 16]; // days for boxes 1..5

export function nextDate(from, days) {
  const d = new Date(from);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

export function initSchedule(today = new Date()) {
  return { box: 1, next: nextDate(today, BOX_INTERVALS[0]), last: today.toISOString().slice(0,10) };
}

export function updateSchedule(schedule, correct, today = new Date()) {
  let box = correct ? Math.min(5, (schedule.box || 1) + 1) : 1;
  const days = BOX_INTERVALS[box - 1];
  return { box, next: nextDate(today, days), last: today.toISOString().slice(0, 10) };
}

export function getDue(cards, today = new Date()) {
  const todayStr = today.toISOString().slice(0, 10);
  const due = cards.filter(c => !c.schedule || c.schedule.next <= todayStr);
  // Interleaving: shuffle by least recently seen subject
  const bySubject = new Map();
  for (const c of due) {
    const s = (c.subject || 'General').toLowerCase();
    if (!bySubject.has(s)) bySubject.set(s, []);
    bySubject.get(s).push(c);
  }
  const subjects = [...bySubject.keys()];
  const out = [];
  let i = 0;
  while (out.length < 12 && subjects.length) {
    const s = subjects[i % subjects.length];
    const arr = bySubject.get(s);
    if (arr && arr.length) out.push(arr.shift());
    if (arr && arr.length === 0) { bySubject.delete(s); subjects.splice(i % subjects.length, 1); i--; }
    i++;
    if (subjects.length === 0) break;
  }
  return out;
}

export function getDueCount(cards, today = new Date()) {
  const todayStr = today.toISOString().slice(0, 10);
  return cards.filter(c => !c.schedule || c.schedule.next <= todayStr).length;
}
