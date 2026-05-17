// Teams チャネル設定 (内部用 / 外部用)。
//
// 保存先は SharePoint の SpiraSettings リスト (Spira 全体で共有)。
// 以前は localStorage だったが、複数ユーザーで設定を共有するため
// SP 側にしてあり、PA フローからも参照可能 (Get item by SettingKey)。
//
// チャネル URL を入力させ、URL から Channel ID / Team ID を抽出して保存する。

import { getRepo } from '../api/repo';

export interface TeamsChannelConfig {
  /** ユーザーが入力した URL (生) */
  url: string;
  /** 19:xxxx@thread.tacv2 形式の Channel ID */
  channelId: string;
  /** M365 グループ GUID */
  teamId: string;
  /** チャネル名 (URL に含まれていればデコード後の文字列) */
  channelName?: string;
}

const KEY_INTERNAL = 'teams-channel:internal';
const KEY_EXTERNAL = 'teams-channel:external';

/** Teams チャネル URL から ID 群を取り出す。
 *  対応形式:
 *    1. /l/channel/<encChannelId>/<encName>?groupId=<guid>&tenantId=<guid>
 *    2. /dl/launcher/launcher.html?url=<encoded inner url>&...  ← 中の url を再帰 */
export function parseTeamsChannelUrl(input: string): TeamsChannelConfig | null {
  const raw = input.trim();
  if (!raw) return null;

  let u: URL;
  try { u = new URL(raw); } catch { return null; }
  if (!u.hostname.endsWith('teams.microsoft.com')) return null;

  if (u.pathname.includes('/dl/launcher/')) {
    const inner = u.searchParams.get('url');
    if (inner) return parseTeamsChannelUrl(decodeURIComponent(inner));
    return null;
  }

  const match = u.pathname.match(/\/l\/channel\/([^/]+)(?:\/([^/]+))?/);
  if (!match) return null;
  const channelId = decodeURIComponent(match[1]!);
  const channelName = match[2] ? safeDecodeName(match[2]) : undefined;
  const teamId = u.searchParams.get('groupId') ?? '';
  if (!channelId || !teamId) return null;

  return { url: raw, channelId, teamId, channelName };
}

function safeDecodeName(s: string): string {
  try {
    let v = decodeURIComponent(s);
    if (/^%[0-9A-Fa-f]{2}/.test(v)) {
      try { v = decodeURIComponent(v); } catch { /* noop */ }
    }
    return v;
  } catch { return s; }
}

// 単純メモリキャッシュ。設定変更直後の再読み込みを避ける。
const cache: Record<string, TeamsChannelConfig | null | undefined> = {};

async function readSlot(key: string): Promise<TeamsChannelConfig | null> {
  if (key in cache) return cache[key] ?? null;
  try {
    const raw = await getRepo().getSetting(key);
    const v = raw ? JSON.parse(raw) as TeamsChannelConfig : null;
    cache[key] = v;
    return v;
  } catch { return null; }
}

async function writeSlot(key: string, cfg: TeamsChannelConfig | null): Promise<void> {
  await getRepo().setSetting(key, cfg ? JSON.stringify(cfg) : null);
  cache[key] = cfg;
}

export const getInternalChannelConfig = (): Promise<TeamsChannelConfig | null> => readSlot(KEY_INTERNAL);
export const setInternalChannelConfig = (cfg: TeamsChannelConfig | null): Promise<void> => writeSlot(KEY_INTERNAL, cfg);
export const getExternalChannelConfig = (): Promise<TeamsChannelConfig | null> => readSlot(KEY_EXTERNAL);
export const setExternalChannelConfig = (cfg: TeamsChannelConfig | null): Promise<void> => writeSlot(KEY_EXTERNAL, cfg);
