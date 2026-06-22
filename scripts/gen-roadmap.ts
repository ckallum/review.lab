#!/usr/bin/env bun
//
// Generates docs/roadmap.html from .claude/specs/review-dev-mvp/tasks.md.
// Run after ticket states change: `bun run roadmap`.
//
// Status is derived, not hand-maintained:
//   - done    — checkbox ticked in tasks.md, no open PR
//   - review  — a ticket id (T<phase>.<n>) appears in an open PR title (via gh)
//   - next    — the first remaining unticked ticket in document order
//   - todo    — everything else unticked
//
// The output is deterministic (no timestamps) so re-running with an unchanged
// tasks.md produces no diff. docs/ is in .prettierignore — this file is the
// source of truth, not the generated HTML.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TASKS_PATH = join(ROOT, '.claude', 'specs', 'review-dev-mvp', 'tasks.md');
const OUT_PATH = join(ROOT, 'docs', 'roadmap.html');

type Status = 'done' | 'review' | 'next' | 'todo';
type Ticket = { id: string; title: string; checked: boolean; status: Status; pr?: number };
type Phase = { num: number; name: string; tickets: Ticket[] };

// Editorial overlay — milestones aren't in tasks.md. Keyed by the phase number
// they render *after*.
const MILESTONES: Record<
  number,
  { title: string; sub: string; icon: 'flag' | 'target'; full?: boolean }
> = {
  1: {
    title: 'Walking-skeleton MVP',
    sub: 'publish → browse → approve runs end-to-end on file-based chapters — no API key',
    icon: 'flag',
  },
  2: {
    title: 'Full working MVP — dogfood-ready',
    sub: 'LLM chapters streaming over SSE, author attribution, cost guardrails. The real product.',
    icon: 'target',
    full: true,
  },
};

function parseTasks(md: string): Phase[] {
  const phases: Phase[] = [];
  let current: Phase | undefined;
  for (const line of md.split('\n')) {
    const ph = line.match(/^## Phase (\d+) — (.+)$/);
    if (ph) {
      // Drop the "(Week 1)" / "(Month ...)" parenthetical from the name.
      const name = `Phase ${ph[1]} — ${ph[2].replace(/\s*\(.*\)\s*$/, '').trim()}`;
      current = { num: Number(ph[1]), name, tickets: [] };
      phases.push(current);
      continue;
    }
    const tk = line.match(/^- \[([ x])\] \*\*(T\d+\.\d+) — (.+?)\.\*\*/);
    if (tk && current) {
      current.tickets.push({
        id: tk[2],
        title: tk[3].replace(/`/g, '').trim(),
        checked: tk[1] === 'x',
        status: 'todo',
      });
    }
  }
  return phases;
}

// Map ticket id → open PR number by scanning open PR titles for "T<n>.<n>".
// Best-effort: if gh is missing or offline, no review overlay is applied.
function openPrTickets(): Map<string, number> {
  const map = new Map<string, number>();
  try {
    const out = execFileSync('gh', ['pr', 'list', '--state', 'open', '--json', 'number,title'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const pr of JSON.parse(out) as { number: number; title: string }[]) {
      for (const m of pr.title.matchAll(/T\d+\.\d+/g)) {
        if (!map.has(m[0])) map.set(m[0], pr.number);
      }
    }
  } catch {
    // gh unavailable — fall back to checkbox-only status.
  }
  return map;
}

function assignStatus(phases: Phase[], prTickets: Map<string, number>): void {
  let nextClaimed = false;
  for (const phase of phases) {
    for (const t of phase.tickets) {
      const pr = prTickets.get(t.id);
      if (pr !== undefined) {
        t.status = 'review';
        t.pr = pr;
      } else if (t.checked) {
        t.status = 'done';
      } else if (!nextClaimed) {
        t.status = 'next';
        nextClaimed = true;
      } else {
        t.status = 'todo';
      }
    }
  }
}

const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const DOT: Record<Status, string> = { done: 'd', review: 'r', next: 'n', todo: '' };

function chip(t: Ticket): string {
  const cls = t.status === 'todo' ? 'chip' : `chip ${t.status}`;
  let tag = '';
  if (t.status === 'review') tag = `<span class="tag r">#${t.pr}</span>`;
  else if (t.status === 'next') tag = `<span class="tag n">next</span>`;
  return `    <div class="${cls}"><span class="dot ${DOT[t.status]}"></span><span class="tid">${t.id}</span><span class="tt">${esc(t.title)}</span>${tag}</div>`;
}

function milestoneBand(m: (typeof MILESTONES)[number]): string {
  const icon =
    m.icon === 'flag'
      ? '<path d="M5 21V4"/><path d="M5 4h12l-2.5 4L17 12H5"/>'
      : '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>';
  return `  <div class="ms${m.full ? ' full' : ''}">
    <div class="ms-ic"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon}</svg></div>
    <div><div class="ms-t">${esc(m.title)}</div><div class="ms-s">${esc(m.sub)}</div></div>
  </div>`;
}

function render(phases: Phase[]): string {
  const all = phases.flatMap((p) => p.tickets);
  const total = all.length;
  // Count by derived status, not raw checkbox: a ticket in an open PR reads as
  // "in review" (not yet "done") even once its box is ticked on the PR branch.
  const done = all.filter((t) => t.status === 'done').length;
  const reviews = all.filter((t) => t.status === 'review');
  const next = all.find((t) => t.status === 'next');
  const currentPhase = next
    ? phases.find((p) => p.tickets.includes(next))!
    : phases[phases.length - 1];

  const reviewClause = reviews.length
    ? ` · ${reviews.map((t) => `${t.id} #${t.pr}`).join(', ')} in review`
    : '';
  const nextClause = next ? ` · ${next.id} next` : '';
  const subtitle = `${esc(currentPhase.name)} · ${done} of ${total} merged${reviewClause}${nextClause}`;

  const seg = all.map((t) => `<span class="${DOT[t.status]}"></span>`).join('');

  const reviewMetric = reviews.length ? reviews.map((t) => `#${t.pr}`).join(', ') : '—';
  const nextMetric = next ? next.id : '—';

  const body = phases
    .map((p) => {
      const phaseDone = p.tickets.filter((t) => t.status === 'done').length;
      const grid = p.tickets.map(chip).join('\n');
      let section = `  <div class="ph"><span class="nm">${esc(p.name)}</span><span class="ct">${phaseDone} / ${p.tickets.length}</span><span class="ln"></span></div>
  <div class="grid">
${grid}
  </div>`;
      if (MILESTONES[p.num]) section += `\n\n${milestoneBand(MILESTONES[p.num])}`;
      return section;
    })
    .join('\n\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>review.dev — MVP roadmap</title>
<!-- GENERATED by scripts/gen-roadmap.ts from .claude/specs/review-dev-mvp/tasks.md. Do not edit by hand; run \`bun run roadmap\`. -->
<style>
  :root{
    --bg:#faf9f5; --surface:#f1efe8; --card:#ffffff; --text:#1d1c1a; --muted:#5f5e5a; --faint:#888780;
    --border:rgba(0,0,0,.12); --green:#639922; --blue:#378add; --blue-t:#185fa5; --blue-bg:#e6f1fb;
    --amber:#ba7517; --amber-t:#854f0b; --amber-bg:#faeeda; --gray:#b4b2a9;
    --font:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#1a1a18; --surface:#242420; --card:#201f1d; --text:#ececea; --muted:#b4b2a9; --faint:#888780;
      --border:rgba(255,255,255,.14); --green:#97c459; --blue:#85b7eb; --blue-t:#b5d4f4; --blue-bg:#0c2740;
      --amber:#ef9f27; --amber-t:#fac775; --amber-bg:#3a2a0c; --gray:#5f5e5a;
    }
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:var(--font);line-height:1.55;-webkit-font-smoothing:antialiased;padding:2.5rem 1rem}
  .wrap{max-width:780px;margin:0 auto}
  h1{font-size:24px;font-weight:600;margin:0 0 4px}
  .sub{color:var(--muted);font-size:14px;margin:0 0 1.75rem}
  .cards{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:1.5rem}
  .c{background:var(--surface);border-radius:10px;padding:12px 14px}
  .c .l{font-size:12px;color:var(--muted);margin:0 0 4px}
  .c .v{font-size:22px;font-weight:600;line-height:1.1}
  .c .v small{font-size:13px;color:var(--faint);font-weight:400}
  .seg{display:flex;gap:2px;height:10px;margin:0 0 1.5rem}
  .seg span{flex:1;border-radius:2px;background:var(--gray);opacity:.55}
  .seg .d{background:var(--green);opacity:1}.seg .r{background:var(--blue);opacity:1}.seg .n{background:var(--amber);opacity:1}
  .legend{display:flex;flex-wrap:wrap;gap:16px;font-size:12.5px;color:var(--muted);margin:0 0 2rem}
  .legend span{display:flex;align-items:center;gap:6px}
  .dot{width:9px;height:9px;border-radius:50%;flex:none;background:var(--gray)}
  .dot.d{background:var(--green)}.dot.r{background:var(--blue)}.dot.n{background:var(--amber)}
  .ph{display:flex;align-items:center;gap:10px;margin:1.5rem 0 .7rem}
  .ph .nm{font-size:15px;font-weight:600}
  .ph .ct{font-size:12px;color:var(--muted);background:var(--surface);padding:2px 8px;border-radius:8px}
  .ph .ln{flex:1;height:1px;background:var(--border)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:8px}
  .chip{display:flex;align-items:center;gap:8px;padding:9px 11px;border:1px solid var(--border);border-radius:8px;background:var(--card);font-size:13px;min-width:0}
  .chip .tid{font-family:var(--mono);font-size:11px;font-weight:600;color:var(--muted);flex:none}
  .chip .tt{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .chip.done{background:var(--surface)}.chip.done .tt{color:var(--muted)}
  .chip.review{border-color:var(--blue)}
  .chip.next{border:2px solid var(--amber);background:var(--amber-bg);padding:8px 10px}
  .tag{font-size:10px;font-weight:600;padding:1px 7px;border-radius:8px;margin-left:auto;flex:none}
  .tag.r{color:var(--blue-t);background:var(--blue-bg)}
  .tag.n{color:var(--amber-t);background:var(--amber-bg)}
  .ms{display:flex;align-items:center;gap:13px;margin:1.1rem 0;padding:13px 15px;border-radius:12px;background:var(--surface)}
  .ms.full{background:var(--blue-bg)}
  .ms-ic{width:36px;height:36px;border-radius:50%;flex:none;display:flex;align-items:center;justify-content:center;background:var(--card);color:var(--muted)}
  .ms.full .ms-ic{color:var(--blue-t)}
  .ms-ic svg{width:20px;height:20px}
  .ms-t{font-size:14px;font-weight:600}
  .ms-s{font-size:12.5px;color:var(--muted)}
  .foot{margin-top:2.5rem;padding-top:1rem;border-top:1px solid var(--border);font-size:12px;color:var(--faint)}
  .foot code{font-family:var(--mono);font-size:11px}
</style>
</head>
<body>
<div class="wrap">
  <h1>review.dev — MVP roadmap</h1>
  <p class="sub">${subtitle}</p>

  <div class="cards">
    <div class="c"><p class="l">Merged</p><div class="v">${done}<small> / ${total}</small></div></div>
    <div class="c"><p class="l">Phase</p><div class="v">${currentPhase.num}<small> of ${phases.length}</small></div></div>
    <div class="c"><p class="l">In review</p><div class="v">${reviewMetric}</div></div>
    <div class="c"><p class="l">Next up</p><div class="v">${nextMetric}</div></div>
  </div>

  <div class="seg" title="roadmap progress">${seg}</div>

  <div class="legend">
    <span><i class="dot d"></i>Done (merged)</span>
    <span><i class="dot r"></i>In review</span>
    <span><i class="dot n"></i>Next</span>
    <span><i class="dot"></i>To do</span>
  </div>

${body}

  <p class="foot">Generated from <code>.claude/specs/review-dev-mvp/tasks.md</code> by <code>scripts/gen-roadmap.ts</code> — run <code>bun run roadmap</code> to refresh. Status colours derive from checkbox state plus open PRs.</p>
</div>
</body>
</html>
`;
}

const phases = parseTasks(readFileSync(TASKS_PATH, 'utf8'));
assignStatus(phases, openPrTickets());
mkdirSync(dirname(OUT_PATH), { recursive: true });
writeFileSync(OUT_PATH, render(phases));

const all = phases.flatMap((p) => p.tickets);
console.log(
  `roadmap: wrote ${OUT_PATH} — ${all.length} tickets across ${phases.length} phases ` +
    `(${all.filter((t) => t.status === 'done').length} done, ` +
    `${all.filter((t) => t.status === 'review').length} in review, ` +
    `${all.filter((t) => t.status === 'next').length} next).`,
);
