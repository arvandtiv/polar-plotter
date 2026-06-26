// User-defined paper sizes (work-area presets), persisted in localStorage so they
// survive reloads. The firmware has no concept of named papers — this is purely a
// console convenience that maps a name to work-area bounds (mm from origin).

export interface Paper {
  name: string;
  up: number; down: number; left: number; right: number;
}

const PAPERS_KEY = 'plotterPapers';

// Seeded default if the user has none yet.
const DEFAULT_PAPERS: Paper[] = [
  { name: 'Water - paper', up: 274, down: 105, left: 260, right: 260 },
];

export function loadPapers(): Paper[] {
  if (typeof localStorage === 'undefined') return [...DEFAULT_PAPERS];
  try {
    const raw = localStorage.getItem(PAPERS_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) return arr as Paper[];
    }
  } catch { /* corrupt → fall back to default */ }
  return [...DEFAULT_PAPERS];
}

export function savePapers(list: Paper[]): void {
  try { localStorage.setItem(PAPERS_KEY, JSON.stringify(list)); } catch { /* quota/denied — ignore */ }
}
