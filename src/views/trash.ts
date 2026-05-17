import { el, fmtDate } from '../utils/dom';
import { icon } from '../icons';
import { getRepo } from '../api/repo';
import { setState, getState } from '../state';
import { confirmModal } from '../components/modal';
import { toast } from '../components/toast';
import { renderStatusBadge } from './ticketList';
import { formatTicketIdShort } from '../utils/ticketTag';
import type { Ticket } from '../types';

export async function renderTrash(): Promise<HTMLElement> {
  const wrap = el('div', { class: 'spira-main-wrap', style: 'display:flex;flex-direction:column;height:100%;min-height:0' });
  const rows = await getRepo().listDeletedTickets();

  const toolbar = el('div', { class: 'spira-toolbar' }, [
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
          onConfirm: async () => {
            try {
              await getRepo().emptyTrash();
              toast(getRoot(), 'ゴミ箱を空にしました', 'ok');
              setState({ trashCount: 0 });
            } catch (e) {
              toast(getRoot(), `失敗: ${(e as Error).message}`, 'error');
            }
          },
        });
      },
    }, ['ゴミ箱を空にする']),
  ]);
  wrap.appendChild(el('div', { class: 'spira-subbar' }, [
    el('div', { class: 'spira-subbar-title' }, [
      el('span', { class: 'spira-subbar-name' }, ['ゴミ箱']),
      el('span', { class: 'spira-subbar-count' }, [`${rows.length} 件`]),
    ]),
  ]));
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
  wrap.appendChild(el('div', { class: 'spira-content', style: 'padding:0' }, [
    el('div', { class: 'spira-table-wrap' }, [table]),
  ]));
  return wrap;
}

function renderRow(t: Ticket): HTMLElement {
  return el('tr', { class: 'spira-tk-row' }, [
    el('td', { class: 'spira-tk-id' }, [formatTicketIdShort(t.id)]),
    el('td', { class: 'spira-tk-title' }, [t.title]),
    el('td', {}, [renderStatusBadge(t.status)]),
    el('td', {}, [fmtDate(t.deletedAt)]),
    el('td', { style: 'text-align:right' }, [
      el('button', {
        class: 'spira-btn spira-btn--secondary spira-btn--sm',
        onclick: async () => {
          try {
            await getRepo().restoreTicket(t.id);
            toast(getRoot(), `#${String(t.id).padStart(3, '0')} を復元しました`, 'ok');
            setState({ trashCount: Math.max(0, getState().trashCount - 1) });
          } catch (e) {
            toast(getRoot(), `復元失敗: ${(e as Error).message}`, 'error');
          }
        },
      }, ['復元']),
      ' ',
      el('button', {
        class: 'spira-btn spira-btn--sm spira-btn--icon-trash',
        title: '物理削除 (完全に削除)',
        'aria-label': '物理削除',
        onclick: () => {
          confirmModal(getRoot(), {
            title: '物理削除',
            message: `#${String(t.id).padStart(3, '0')} 「${t.title}」 を完全に削除します。元に戻せません。`,
            primaryLabel: '物理削除',
            primaryVariant: 'danger',
            onConfirm: async () => {
              try {
                await getRepo().hardDeleteTicket(t.id);
                toast(getRoot(), '物理削除しました', 'ok');
                setState({ trashCount: Math.max(0, getState().trashCount - 1) });
              } catch (e) {
                toast(getRoot(), `失敗: ${(e as Error).message}`, 'error');
              }
            },
          });
        },
      }, [el('span', { html: icon('trash'), style: 'display:inline-flex;width:14px;height:14px' })]),
    ]),
  ]);
}

function getRoot(): HTMLElement {
  return document.querySelector<HTMLElement>('.spira-root') ?? document.body;
}
