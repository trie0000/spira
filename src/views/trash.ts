import { el, fmtDate } from '../utils/dom';
import {
  listDeletedTicketsMock, restoreTicketMock,
  hardDeleteTicketMock, emptyTrashMock,
} from '../api/mock';
import { setState } from '../state';
import { confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { renderStatusBadge } from './ticketList';
import type { Ticket } from '../types';

export function renderTrash(): HTMLElement {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const rows = listDeletedTicketsMock().sort((a, b) => (b.deletedAt ?? '').localeCompare(a.deletedAt ?? ''));

  const toolbar = el('div', { class: 'spira-toolbar' }, [
    el('div', { style: 'font-weight:500;color:var(--ink);font-size:var(--fs-md)' }, [`ゴミ箱 (${rows.length})`]),
    el('div', { class: 'spira-toolbar-spacer' }),
    el('button', {
      class: 'spira-btn spira-btn--danger spira-btn--sm',
      onclick: () => {
        if (rows.length === 0) return;
        confirmModal(getRoot(), {
          title: 'ゴミ箱を空にする',
          message: `${rows.length} 件のチケットと関連 Comments を物理削除します。元に戻せません。`,
          primaryLabel: '空にする',
          primaryVariant: 'danger',
          onConfirm: () => {
            emptyTrashMock();
            toast(getRoot(), 'ゴミ箱を空にしました', 'ok');
            setState({});
          },
        });
      },
    }, ['ゴミ箱を空にする']),
  ]);
  wrap.appendChild(toolbar);

  if (rows.length === 0) {
    wrap.appendChild(el('div', { class: 'spira-content' }, [
      el('div', { class: 'spira-empty' }, [
        el('div', { class: 'spira-empty-title' }, ['ゴミ箱は空です']),
      ]),
    ]));
    return wrap;
  }

  const table = el('table', { class: 'spira-tk-table' }, [
    el('thead', {}, [
      el('tr', {}, ['#', 'Title', 'Status', '削除日時', ''].map(h => el('th', {}, [h]))),
    ]),
    el('tbody', {}, rows.map(t => renderRow(t))),
  ]);
  wrap.appendChild(el('div', { class: 'spira-content', style: 'padding:0' }, [table]));
  return wrap;
}

function renderRow(t: Ticket): HTMLElement {
  return el('tr', { class: 'spira-tk-row' }, [
    el('td', { class: 'spira-tk-id' }, [`#${String(t.id).padStart(3, '0')}`]),
    el('td', { class: 'spira-tk-title' }, [t.title]),
    el('td', {}, [renderStatusBadge(t.status)]),
    el('td', {}, [fmtDate(t.deletedAt)]),
    el('td', { style: 'text-align:right' }, [
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: () => {
          restoreTicketMock(t.id);
          toast(getRoot(), `#${String(t.id).padStart(3, '0')} を復元しました`, 'ok');
          setState({});
        },
      }, ['復元']),
      ' ',
      el('button', {
        class: 'spira-btn spira-btn--danger spira-btn--sm',
        onclick: () => {
          confirmModal(getRoot(), {
            title: '物理削除',
            message: `#${String(t.id).padStart(3, '0')} 「${t.title}」 を完全に削除します。元に戻せません。`,
            primaryLabel: '物理削除',
            primaryVariant: 'danger',
            onConfirm: () => {
              hardDeleteTicketMock(t.id);
              toast(getRoot(), '物理削除しました', 'ok');
              setState({});
            },
          });
        },
      }, ['物理削除']),
    ]),
  ]);
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.spira-root') ?? document.body;
}
