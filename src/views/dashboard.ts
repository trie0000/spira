// ダッシュボード ビュー — 「現状把握」用の集計表示。
//
// 設計方針:
//   - SLA 違反などの「警告」言葉は使わず、純粋に現状を可視化する。
//   - 既存の Tickets リストデータだけから集計 (SP 列追加なし)。
//   - チャートライブラリ依存なし — HTML + CSS の div で横棒、SVG で
//     折れ線/縦棒を最小限に手書き。
//
// 構成 (上から):
//   A. KPI カード      対応中 / 確認待ち / 今週新規 / 今週完了 / 未割当
//   B. ステータス分布   横棒スタック
//   C. 担当者別        オープン分の横棒
//   D. 部門 / 種別別    オープン分の横棒
//   E. 経過日数別      今日 / 昨日 / 2-7 日 / 8-30 日 / 30 日以上
//   F. 古い順 TOP 10   未完了のうち最も古いもの 10 件、クリックでジャンプ
//   G. 30 日推移       新規 / 完了 の縦棒

import { el, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { renderStatusBadge, renderPriorityLabel, renderAssignee } from './ticketList';
import { formatTicketIdShort } from '../utils/ticketTag';
import type { Ticket, TicketStatus } from '../types';

const STATUS_ORDER: TicketStatus[] = ['新規', '対応中', '確認待ち', '完了'];
const STATUS_COLORS: Record<TicketStatus, string> = {
  '新規':     '#7a8aa9',  // slate blue
  '対応中':   '#3d8b8a',  // teal
  '確認待ち': '#c47f1c',  // amber
  '完了':     '#5a7a4d',  // forest green
};

export async function renderDashboard(): Promise<HTMLElement> {
  const wrap = el('div', {
    class: 'spira-content spira-dashboard',
    style: 'padding:var(--s-7);overflow:auto',
  });

  // タイトル
  wrap.appendChild(el('div', {
    style: 'display:flex;align-items:center;gap:var(--s-3);margin-bottom:var(--s-6)',
  }, [
    el('h1', {
      style: 'font-size:var(--fs-xl);font-weight:600;color:var(--ink);margin:0',
    }, ['📊 ダッシュボード']),
    el('span', {
      style: 'color:var(--ink-3);font-size:var(--fs-sm)',
    }, [`(${fmtDate(new Date().toISOString(), false)} 時点)`]),
  ]));

  // データ取得 (削除済を除く)
  const tickets = await getRepo().listTickets({ includeDeleted: false });

  // 集計
  const now = Date.now();
  const oneWeekAgo = now - 7 * 24 * 60 * 60 * 1000;
  const open = tickets.filter(t => t.status !== '完了');
  const inProgress = tickets.filter(t => t.status === '対応中').length;
  const waiting   = tickets.filter(t => t.status === '確認待ち').length;
  const newThisWeek = tickets.filter(t => new Date(t.createdAt).getTime() >= oneWeekAgo).length;
  const doneThisWeek = tickets.filter(t =>
    t.status === '完了' && new Date(t.updatedAt).getTime() >= oneWeekAgo,
  ).length;
  const unassigned = open.filter(t => !t.assigneeEmails || t.assigneeEmails.length === 0).length;

  // 前週比 — 1〜2 週前のスナップショット相当
  const twoWeeksAgo = now - 14 * 24 * 60 * 60 * 1000;
  const newLastWeek = tickets.filter(t => {
    const tm = new Date(t.createdAt).getTime();
    return tm >= twoWeeksAgo && tm < oneWeekAgo;
  }).length;
  const doneLastWeek = tickets.filter(t => {
    const tm = new Date(t.updatedAt).getTime();
    return t.status === '完了' && tm >= twoWeeksAgo && tm < oneWeekAgo;
  }).length;

  // ── A. KPI カード ──────────────────────────────────────────────────
  wrap.appendChild(renderKpiCards([
    { label: '対応中',     value: inProgress, color: STATUS_COLORS['対応中'] },
    { label: '確認待ち',   value: waiting,    color: STATUS_COLORS['確認待ち'] },
    { label: '今週新規',   value: newThisWeek,  delta: newThisWeek - newLastWeek,  color: '#7a8aa9' },
    { label: '今週完了',   value: doneThisWeek, delta: doneThisWeek - doneLastWeek, color: '#5a7a4d' },
    { label: '未割当',     value: unassigned, color: unassigned > 0 ? '#a05a8c' : '#9aa0a6' },
  ]));

  // ── B. ステータス別 (横棒スタック) ─────────────────────────────────
  const statusCounts = STATUS_ORDER.map(s => ({
    label: s, count: tickets.filter(t => t.status === s).length, color: STATUS_COLORS[s],
  }));
  wrap.appendChild(renderSection('ステータス分布', renderStackedBar(statusCounts)));

  // 2 列レイアウト (C + D)
  const twoCol = el('div', {
    style: 'display:grid;grid-template-columns:1fr 1fr;gap:var(--s-5);margin-bottom:var(--s-5)',
  });

  // ── C. 担当者別ワークロード (オープン分) ────────────────────────────
  const assigneeMap = new Map<string, { name: string; email: string; count: number }>();
  for (const t of open) {
    if (!t.assigneeEmails || t.assigneeEmails.length === 0) {
      const k = '(未割当)';
      const cur = assigneeMap.get(k) ?? { name: '(未割当)', email: '', count: 0 };
      cur.count++;
      assigneeMap.set(k, cur);
      continue;
    }
    // 複数アサイン: 各担当者にカウント (重複あり)
    for (let i = 0; i < t.assigneeEmails.length; i++) {
      const email = t.assigneeEmails[i]!;
      const name = t.assigneeNames?.[i] ?? email;
      const cur = assigneeMap.get(email) ?? { name, email, count: 0 };
      cur.count++;
      assigneeMap.set(email, cur);
    }
  }
  const assigneeRows = Array.from(assigneeMap.values())
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  twoCol.appendChild(renderSection(
    '担当者別ワークロード (オープン分)',
    assigneeRows.length === 0
      ? renderEmpty('未割当のチケットなし')
      : renderHorizontalBars(assigneeRows.map(r => ({
          label: r.name, value: r.count, color: '#3d8b8a',
        }))),
  ));

  // ── D. 部門 / 種別別 (オープン分) ────────────────────────────────────
  const deptMap = new Map<string, number>();
  const catMap = new Map<string, number>();
  for (const t of open) {
    if (t.department) deptMap.set(t.department, (deptMap.get(t.department) ?? 0) + 1);
    if (t.inquiryCategory) catMap.set(t.inquiryCategory, (catMap.get(t.inquiryCategory) ?? 0) + 1);
  }
  const deptRows = Array.from(deptMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: k, value: v, color: '#7c4f8c' }));
  const catRows = Array.from(catMap.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([k, v]) => ({ label: k, value: v, color: '#a05a8c' }));
  twoCol.appendChild(renderSection(
    '部門 / 種別別 (オープン分)',
    el('div', { style: 'display:flex;flex-direction:column;gap:var(--s-4)' }, [
      el('div', {}, [
        el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:4px' }, ['部門']),
        deptRows.length === 0 ? renderEmpty('部門未設定') : renderHorizontalBars(deptRows),
      ]),
      el('div', {}, [
        el('div', { style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:4px' }, ['種別']),
        catRows.length === 0 ? renderEmpty('種別未設定') : renderHorizontalBars(catRows),
      ]),
    ]),
  ));
  wrap.appendChild(twoCol);

  // ── E. 経過日数別 (オープン分) + F. 古い順 TOP 10 (2 列) ─────────────
  const twoCol2 = el('div', {
    style: 'display:grid;grid-template-columns:1fr 1fr;gap:var(--s-5);margin-bottom:var(--s-5)',
  });

  const ageBuckets = computeAgeBuckets(open, now);
  twoCol2.appendChild(renderSection(
    '経過日数別 (オープン分)',
    renderHorizontalBars(ageBuckets.map(b => ({
      label: b.label, value: b.count,
      color: b.danger ? '#b85a3c' : (b.warn ? '#c47f1c' : '#5e6f5c'),
    }))),
  ));

  const oldest = open
    .slice()
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
    .slice(0, 10);
  twoCol2.appendChild(renderSection(
    '古い順 TOP 10 (オープン分)',
    oldest.length === 0
      ? renderEmpty('オープン チケットなし')
      : renderOldestList(oldest, now),
  ));
  wrap.appendChild(twoCol2);

  // ── G. 30 日推移 ────────────────────────────────────────────────────
  wrap.appendChild(renderSection(
    '30 日推移 (新規 / 完了)',
    renderTrendChart(tickets, now),
  ));

  return wrap;
}

// ─── KPI Cards ──────────────────────────────────────────────────────────

interface KpiCard {
  label: string;
  value: number;
  delta?: number;
  color: string;
}
function renderKpiCards(cards: KpiCard[]): HTMLElement {
  return el('div', {
    style: `display:grid;grid-template-columns:repeat(${cards.length}, 1fr);` +
           'gap:var(--s-4);margin-bottom:var(--s-6)',
  }, cards.map(c => {
    const deltaEl = (c.delta !== undefined)
      ? el('span', {
          style: `font-size:var(--fs-xs);color:${c.delta > 0 ? '#3d8b8a' : (c.delta < 0 ? '#b85a3c' : 'var(--ink-3)')};margin-left:6px`,
        }, [c.delta > 0 ? `+${c.delta}` : (c.delta < 0 ? String(c.delta) : '±0')])
      : null;
    return el('div', {
      style: 'background:var(--paper);border:1px solid var(--line);border-radius:var(--r-2);padding:var(--s-4)',
    }, [
      el('div', {
        style: 'font-size:var(--fs-xs);color:var(--ink-3);margin-bottom:6px',
      }, [c.label]),
      el('div', {
        style: 'display:flex;align-items:baseline',
      }, [
        el('span', {
          style: `font-size:28px;font-weight:600;color:${c.color}`,
        }, [String(c.value)]),
        ...(deltaEl ? [deltaEl] : []),
      ]),
    ]);
  }));
}

// ─── Section wrapper ────────────────────────────────────────────────────

function renderSection(title: string, content: HTMLElement): HTMLElement {
  return el('section', {
    style: 'background:var(--paper);border:1px solid var(--line);border-radius:var(--r-2);' +
           'padding:var(--s-5);margin-bottom:var(--s-5)',
  }, [
    el('h2', {
      style: 'font-size:var(--fs-md);font-weight:600;color:var(--ink);margin:0 0 var(--s-4) 0',
    }, [title]),
    content,
  ]);
}

function renderEmpty(message: string): HTMLElement {
  return el('div', {
    style: 'color:var(--ink-3);font-size:var(--fs-sm);padding:var(--s-3);text-align:center',
  }, [message]);
}

// ─── Stacked horizontal bar (status distribution) ────────────────────────

interface BarSegment { label: string; count: number; color: string }
function renderStackedBar(segments: BarSegment[]): HTMLElement {
  const total = segments.reduce((s, x) => s + x.count, 0) || 1;
  const barRow = el('div', {
    style: 'display:flex;height:32px;border-radius:var(--r-2);overflow:hidden;background:var(--paper-2)',
  });
  for (const s of segments) {
    if (s.count === 0) continue;
    const pct = (s.count / total) * 100;
    barRow.appendChild(el('div', {
      title: `${s.label}: ${s.count} 件 (${pct.toFixed(1)}%)`,
      style: `width:${pct.toFixed(2)}%;background:${s.color};` +
             'display:flex;align-items:center;justify-content:center;color:#fff;font-size:11px;font-weight:600',
    }, [pct >= 6 ? `${s.label} ${s.count}` : '']));
  }
  // 凡例
  const legend = el('div', {
    style: 'display:flex;gap:var(--s-4);flex-wrap:wrap;margin-top:var(--s-3);font-size:var(--fs-xs);color:var(--ink-3)',
  }, segments.map(s => el('span', {
    style: 'display:inline-flex;align-items:center;gap:4px',
  }, [
    el('span', { style: `display:inline-block;width:10px;height:10px;border-radius:2px;background:${s.color}` }),
    `${s.label} ${s.count}`,
  ])));
  return el('div', {}, [barRow, legend]);
}

// ─── Horizontal bars (workload / dept / age) ─────────────────────────────

interface BarRow { label: string; value: number; color: string }
function renderHorizontalBars(rows: BarRow[]): HTMLElement {
  if (rows.length === 0) return renderEmpty('データなし');
  const max = Math.max(...rows.map(r => r.value), 1);
  return el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, rows.map(r => {
    const pct = (r.value / max) * 100;
    return el('div', {
      style: 'display:grid;grid-template-columns:130px 1fr 40px;gap:var(--s-3);align-items:center;font-size:var(--fs-sm)',
    }, [
      el('span', {
        style: 'color:var(--ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        title: r.label,
      }, [r.label]),
      el('div', {
        style: 'height:18px;background:var(--paper-2);border-radius:9px;overflow:hidden',
      }, [
        el('div', {
          style: `height:100%;width:${pct.toFixed(2)}%;background:${r.color};border-radius:9px;transition:width 0.3s`,
        }),
      ]),
      el('span', {
        style: 'color:var(--ink);font-weight:500;text-align:right',
      }, [String(r.value)]),
    ]);
  }));
}

// ─── Age buckets ────────────────────────────────────────────────────────

interface AgeBucket { label: string; count: number; warn?: boolean; danger?: boolean }
function computeAgeBuckets(open: Ticket[], now: number): AgeBucket[] {
  const buckets: AgeBucket[] = [
    { label: '今日',        count: 0 },
    { label: '昨日',        count: 0 },
    { label: '2〜7 日前',    count: 0 },
    { label: '8〜30 日前',   count: 0, warn: true },
    { label: '30 日以上',    count: 0, danger: true },
  ];
  const day = 24 * 60 * 60 * 1000;
  for (const t of open) {
    const age = now - new Date(t.createdAt).getTime();
    if (age < day) buckets[0]!.count++;
    else if (age < 2 * day) buckets[1]!.count++;
    else if (age < 7 * day) buckets[2]!.count++;
    else if (age < 30 * day) buckets[3]!.count++;
    else buckets[4]!.count++;
  }
  return buckets;
}

// ─── Oldest tickets list ────────────────────────────────────────────────

function renderOldestList(tickets: Ticket[], now: number): HTMLElement {
  return el('div', { style: 'display:flex;flex-direction:column;gap:6px' }, tickets.map(t => {
    const days = Math.floor((now - new Date(t.createdAt).getTime()) / (24 * 60 * 60 * 1000));
    return el('div', {
      style: 'display:flex;align-items:center;gap:var(--s-3);padding:6px 8px;border-radius:var(--r-2);cursor:pointer;font-size:var(--fs-sm);transition:background 0.1s',
      onclick: () => {
        const open = getState().openTicketIds;
        setState({
          view: 'tickets',
          selectedTicketId: t.id,
          openTicketIds: open.includes(t.id) ? open : [...open, t.id],
        });
      },
      onmouseenter: (e: Event) => { (e.currentTarget as HTMLElement).style.background = 'var(--paper-2)'; },
      onmouseleave: (e: Event) => { (e.currentTarget as HTMLElement).style.background = ''; },
    }, [
      el('span', {
        style: 'font-family:ui-monospace,Menlo,monospace;color:var(--ink-3);min-width:60px;font-size:var(--fs-xs)',
      }, [formatTicketIdShort(t.id)]),
      renderStatusBadge(t.status),
      renderPriorityLabel(t.priority),
      el('span', {
        style: 'flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap',
        title: t.title,
      }, [t.title]),
      renderAssignee(t.assigneeNames, t.assigneeEmails),
      el('span', {
        style: `font-size:var(--fs-xs);color:${days >= 30 ? '#b85a3c' : (days >= 8 ? '#c47f1c' : 'var(--ink-3)')};min-width:80px;text-align:right`,
      }, [`${days} 日経過`]),
    ]);
  }));
}

// ─── 30-day trend (created / completed) ─────────────────────────────────

function renderTrendChart(tickets: Ticket[], now: number): HTMLElement {
  const day = 24 * 60 * 60 * 1000;
  const days = 30;
  const today0 = new Date(now);
  today0.setHours(0, 0, 0, 0);
  const todayMs = today0.getTime();

  // 日付ごとの新規 / 完了 件数を集計
  const created = new Array(days).fill(0) as number[];
  const completed = new Array(days).fill(0) as number[];
  for (const t of tickets) {
    const cMs = new Date(t.createdAt).getTime();
    const cDiff = Math.floor((todayMs - new Date(cMs).setHours(0, 0, 0, 0)) / day);
    if (cDiff >= 0 && cDiff < days) created[days - 1 - cDiff]!++;
    if (t.status === '完了') {
      const uMs = new Date(t.updatedAt).getTime();
      const uDiff = Math.floor((todayMs - new Date(uMs).setHours(0, 0, 0, 0)) / day);
      if (uDiff >= 0 && uDiff < days) completed[days - 1 - uDiff]!++;
    }
  }
  const max = Math.max(...created, ...completed, 1);

  // SVG で描画 (棒幅 16px、ペア間 4px)
  const barW = 8;
  const gap = 2;       // 棒同士の隙間 (新規・完了ペア内)
  const dayW = barW * 2 + gap + 6;  // 1 日あたりの幅
  const chartW = days * dayW + 40;
  const chartH = 180;
  const padTop = 10;
  const padBottom = 24;
  const innerH = chartH - padTop - padBottom;

  const svg = `<svg viewBox="0 0 ${chartW} ${chartH}" width="100%" preserveAspectRatio="xMidYMid meet" style="max-height:${chartH}px">` +
    // Y 軸ガイド (3 本)
    [0.5, 1].map(p => {
      const y = padTop + innerH * (1 - p);
      return `<line x1="30" y1="${y}" x2="${chartW - 10}" y2="${y}" stroke="rgba(0,0,0,0.06)" stroke-dasharray="2,2"/>` +
             `<text x="26" y="${y + 4}" text-anchor="end" font-size="9" fill="#9aa0a6">${Math.round(max * p)}</text>`;
    }).join('') +
    // 棒描画
    created.map((cVal, i) => {
      const x = 36 + i * dayW;
      const cH = (cVal / max) * innerH;
      const dVal = completed[i]!;
      const dH = (dVal / max) * innerH;
      return `<rect x="${x}" y="${padTop + innerH - cH}" width="${barW}" height="${cH}" fill="#7a8aa9" rx="1">` +
             `<title>${days - 1 - i} 日前: 新規 ${cVal}</title></rect>` +
             `<rect x="${x + barW + gap}" y="${padTop + innerH - dH}" width="${barW}" height="${dH}" fill="#5a7a4d" rx="1">` +
             `<title>${days - 1 - i} 日前: 完了 ${dVal}</title></rect>`;
    }).join('') +
    // X 軸ラベル (両端 + 中央)
    [0, Math.floor(days / 2), days - 1].map(i => {
      const x = 36 + i * dayW + barW;
      return `<text x="${x}" y="${chartH - 8}" text-anchor="middle" font-size="9" fill="#9aa0a6">${days - 1 - i}日前</text>`;
    }).join('') +
    '</svg>';

  return el('div', {}, [
    el('div', { html: svg, style: 'width:100%;overflow:auto' }),
    el('div', {
      style: 'display:flex;gap:var(--s-4);justify-content:center;margin-top:var(--s-2);font-size:var(--fs-xs);color:var(--ink-3)',
    }, [
      el('span', { style: 'display:inline-flex;align-items:center;gap:4px' }, [
        el('span', { style: 'display:inline-block;width:12px;height:8px;background:#7a8aa9;border-radius:1px' }),
        '新規',
      ]),
      el('span', { style: 'display:inline-flex;align-items:center;gap:4px' }, [
        el('span', { style: 'display:inline-block;width:12px;height:8px;background:#5a7a4d;border-radius:1px' }),
        '完了',
      ]),
    ]),
  ]);
}

void icon; // 将来アイコン使うかも (placeholder で warning 抑制)
