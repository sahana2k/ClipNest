// lib/utils.js
export function buildTextFragmentUrl(url, text) {
  if (!text) return url;
  const frag = encodeURIComponent(text.trim().slice(0, 80));
  return `${url}#:~:text=${frag}`;
}

export function makeId() {
  return crypto.randomUUID();
}
