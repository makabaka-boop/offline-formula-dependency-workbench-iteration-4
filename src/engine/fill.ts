import { COLS, ROWS, colToLetter, keyOf, normalizeRef, parseAddr, type Addr } from './cells';
import { parseCellInput, refSpans } from './parser';

/** 矩形复制请求：单一源格 -> 以某格为左上角、至多 5×5 的目标矩形 */
export interface CopyRequest {
  source: string;
  /** 目标矩形左上角（规范化前的输入亦可） */
  targetTopLeft: string;
  /** 矩形宽（列数），1..5 */
  width: number;
  /** 矩形高（行数），1..5 */
  height: number;
}

export interface TranslateFailure {
  /** 平移后越界的引用原文（含 $） */
  ref: string;
  /** 越界的一维：列 < A..T 或行 < 1..20 */
  reason: string;
}

function renderRef(col: number, row: number, colAnchored: boolean, rowAnchored: boolean): string {
  return `${colAnchored ? '$' : ''}${colToLetter(col)}${rowAnchored ? '$' : ''}${row + 1}`;
}

/**
 * 把一格原始输入按源格 -> 目标格的行列偏移平移。
 *
 * - 空 / 整数：原样返回（复制的是已核对的常量）。
 * - 合法公式：相对行列按偏移平移；$ 锁定的一维保持不动。
 * - 语法错误的公式：按现有 #ERR! 语义原样复制，不做平移、不参与越界判定。
 *
 * 任一未锁定维度平移后越出 A..T / 1..20，返回 failures（可能不止一个）。
 */
export function translateCellRaw(
  raw: string,
  dCol: number,
  dRow: number,
): { raw: string } | { failures: TranslateFailure[] } {
  // 零偏移即源格自身（源、目标重叠）：逐字保留冻结的源原文，
  // 不做词法重组（不改写大小写 / $ / 空白），也不做越界判定。
  if (dCol === 0 && dRow === 0) return { raw };
  const trimmed = raw.trim();
  if (trimmed === '' || !trimmed.startsWith('=')) {
    return { raw };
  }
  // 原文有语法错误：#ERR! 语义，原文复制（越界检查也不适用）
  try {
    parseCellInput(raw);
  } catch {
    return { raw };
  }

  const body = raw.slice(1);
  const spans = refSpans(body);
  const failures: TranslateFailure[] = [];
  const pieces: string[] = [];
  let cursor = 0;
  for (const s of spans) {
    pieces.push(body.slice(cursor, s.start));
    const nextCol = s.colAnchored ? s.col : s.col + dCol;
    const nextRow = s.rowAnchored ? s.row : s.row + dRow;
    if (nextCol < 0 || nextCol >= COLS || nextRow < 0 || nextRow >= ROWS) {
      const badDim =
        nextCol < 0 || nextCol >= COLS ? `列超出 A..${colToLetter(COLS - 1)}` : `行超出 1..${ROWS}`;
      failures.push({
        ref: renderRef(s.col, s.row, s.colAnchored, s.rowAnchored),
        reason: badDim,
      });
    }
    pieces.push(renderRef(nextCol, nextRow, s.colAnchored, s.rowAnchored));
    cursor = s.end;
  }
  pieces.push(body.slice(cursor));
  if (failures.length > 0) return { failures };
  return { raw: '=' + pieces.join('') };
}

/** 把请求中的两个地址规范化；非法返回原因列表 */
export function normalizeCopyRequest(
  req: CopyRequest,
):
  | { ok: true; source: Addr; targetTopLeft: Addr; width: number; height: number }
  | { ok: false; errors: string[] } {
  const errors: string[] = [];
  const source = normalizeRef(req.source?.trim?.() ?? '');
  if (!source) errors.push(`源格地址 ${JSON.stringify(req.source)} 非法（应为 A1..T20）`);
  const topLeft = normalizeRef(req.targetTopLeft?.trim?.() ?? '');
  if (!topLeft) errors.push(`目标左上角 ${JSON.stringify(req.targetTopLeft)} 非法（应为 A1..T20）`);
  if (!Number.isInteger(req.width) || !Number.isInteger(req.height) || req.width < 1 || req.height < 1) {
    errors.push('目标矩形的宽、高必须是不小于 1 的整数');
  }
  if (errors.length > 0 || !source || !topLeft) return { ok: false, errors };

  if (req.width > 5 || req.height > 5) {
    errors.push(`目标矩形至多 5×5 格（当前 ${req.width}×${req.height}）`);
  }
  const p = parseAddr(topLeft)!;
  if (p.col + req.width > COLS || p.row + req.height > ROWS) {
    errors.push(
      `目标矩形超出网格：从 ${topLeft} 起 ${req.width}×${req.height} 越过 ${colToLetter(COLS - 1)}${ROWS}`,
    );
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    source,
    targetTopLeft: topLeft,
    width: req.width,
    height: req.height,
  };
}

/** 枚举目标矩形全部地址（先行后列，顺序确定） */
export function rectAddrs(topLeft: Addr, width: number, height: number): Addr[] {
  const p = parseAddr(topLeft)!;
  const out: Addr[] = [];
  for (let dr = 0; dr < height; dr++) {
    for (let dc = 0; dc < width; dc++) {
      out.push(keyOf(p.col + dc, p.row + dr)!);
    }
  }
  return out;
}
