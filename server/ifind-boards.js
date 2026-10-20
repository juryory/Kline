// 同花顺概念板块（iFinD 板块树「概念类 → 常规概念」）：板块列表 + 成分股，每周刷新一次。
// 板块树只给节点 ID 和名称，指数代码（885xxx / 886xxx.TI）按名称用 get_thscode 查，结果缓存在 ifind_boards。
// 新兴概念、其他概念没有编制指数，不参与排行。
import { tx } from './db.js';
import { chinaDate } from './ifind-client.js';
import { weekKey } from './ifind-budget.js';

const TREE_ROOT = '001042_1'; // 概念类
const CONCEPT_NODE = '001042'; // 常规概念
const INDEX_CODE = /^88[56]\d{3}\.TI$/;

/** 名称 → 概念指数代码：精确匹配；同名多个品种时模糊匹配且只认唯一的 885/886；仍不确定时用 tushare 列表里的同名板块 */
async function resolveCode(client, name, legacy) {
  let { codes, multiple } = await client.thscode(name);
  if (multiple) ({ codes } = await client.thscode(name, false));
  const hits = [...new Set(codes.filter((c) => INDEX_CODE.test(c)))];
  return hits.length === 1 ? hits[0] : legacy.get(compact(name)) ?? null;
}
// 板块树和指数简称的空格写法可能不同（「WiFi 6」/「WiFi6」）
const compact = (name) => name.replace(/\s+/g, '');

export async function refreshConceptBoards({ db, client, now = Date.now(), log = console.log, force = false } = {}) {
  const week = weekKey(now);
  const done = db.prepare("SELECT value FROM meta WHERE key='ifind_boards_week'").get()?.value;
  if (!force && done === week) return { skipped: true };

  const nodes = await client.report('p03321', { iv_bkid: TREE_ROOT }, 'p03321_f001:Y,p03321_f003:Y,p03321_f004:Y');
  const leaves = nodes.filter((n) => n.p03321_f004 === CONCEPT_NODE)
    .map((n) => ({ blockId: n.p03321_f003, name: n.p03321_f001 }));
  // 防止接口异常返回空树时把现有列表清空
  if (leaves.length < 100) throw new Error(`iFinD 常规概念只返回 ${leaves.length} 个板块，疑似异常，保留现有列表`);

  // 名称没变且已查到代码的沿用缓存；新板块、改名、上次没查到的重新查
  const cached = new Map(db.prepare("SELECT block_id, name, code FROM ifind_boards WHERE list='THN'").all()
    .map((r) => [r.block_id, r]));
  const legacy = new Map(db.prepare("SELECT name, code FROM symbols WHERE category = 'THN'").all()
    .filter((r) => INDEX_CODE.test(r.code)).map((r) => [compact(r.name), r.code]));
  const boards = [];
  let resolved = 0;
  for (const leaf of leaves) {
    const old = cached.get(leaf.blockId);
    let code = old && old.name === leaf.name ? old.code : null;
    if (!code) {
      code = await resolveCode(client, leaf.name, legacy);
      resolved++;
    }
    boards.push({ ...leaf, code });
  }

  // 成分股：最新一天的成分，查不到（-4001）视为空
  const date = chinaDate(now).replaceAll('-', '');
  const members = new Map();
  for (const b of boards.filter((b) => b.code)) {
    const rows = await client.report('p03291', { date, blockname: b.blockId, iv_type: 'allcontract' }, 'p03291_f002:Y');
    members.set(b.code, rows.map((r) => r.p03291_f002).filter(Boolean));
  }

  const putBoard = db.prepare("INSERT INTO ifind_boards VALUES ('THN',?,?,?)");
  const putSymbol = db.prepare("INSERT OR REPLACE INTO ifind_symbols VALUES (?,?,'index','THN')");
  const putMember = db.prepare('INSERT OR IGNORE INTO ifind_members VALUES (?,?)');
  tx(db, () => {
    db.prepare("DELETE FROM ifind_boards WHERE list='THN'").run();
    db.prepare('DELETE FROM ifind_members').run();
    for (const b of boards) {
      putBoard.run(b.blockId, b.name, b.code);
      // 新概念也进标的池，后续日线 / 分时同步会覆盖到
      if (b.code) putSymbol.run(b.code, b.name);
    }
    for (const [board, stocks] of members) for (const s of stocks) putMember.run(board, s);
    db.prepare("INSERT OR REPLACE INTO meta VALUES ('ifind_boards_week', ?)").run(week);
  });
  const withCode = boards.filter((b) => b.code).length;
  const memberCount = [...members.values()].reduce((n, s) => n + s.length, 0);
  log(`[ifind] 概念板块：${leaves.length} 个，${withCode} 个有指数代码（本次按名称查询 ${resolved} 个），成分股 ${memberCount} 条`);
  return { boards: leaves.length, withCode, resolved, members: memberCount };
}
