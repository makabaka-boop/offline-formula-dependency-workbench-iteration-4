import { describe, expect, it } from 'vitest';
import { SheetEngine, type CopyPreview } from './engine';
import { translateCellRaw } from './fill';
import { exportSnapshot, validateImport } from './snapshot';

function make(cells: Record<string, string>): SheetEngine {
  const e = new SheetEngine();
  e.loadGrid(cells);
  return e;
}

function val(e: SheetEngine, addr: string): string | null {
  return e.getSnapshot().states.get(addr)?.value?.toExactString() ?? null;
}

function rawOf(e: SheetEngine, addr: string): string {
  return e.getRaw(addr);
}

function preview(e: SheetEngine, source: string, topLeft: string, width: number, height: number) {
  return e.previewCopy({ source, targetTopLeft: topLeft, width, height });
}

function planMap(p: CopyPreview): Map<string, string> {
  return new Map(p.plans.map((pl) => [pl.target, pl.raw]));
}

/** 平移成功时的文本（断言无越界） */
function shifted(raw: string, dCol: number, dRow: number): string {
  const r = translateCellRaw(raw, dCol, dRow);
  if ('failures' in r) throw new Error(`unexpected failures: ${JSON.stringify(r.failures)}`);
  return r.raw;
}

/* ------------------------- 平移：四种锚定写法 ------------------------- */

describe('矩形复制：$ 锚定（Vitest 核对四种写法）', () => {
  it('相对引用 A1：列与行都随偏移移动', () => {
    expect(shifted('=A1+1', 1, 1)).toBe('=B2+1');
    expect(shifted('=A1+1', 2, 0)).toBe('=C1+1');
    expect(shifted('=a1+1', 1, 0)).toBe('=B1+1'); // 小写规范化为大写
  });

  it('锁列 $A1：列固定，行随行偏移', () => {
    expect(shifted('=$A1+1', 1, 2)).toBe('=$A3+1');
    expect(shifted('=$A1', 5, 5)).toBe('=$A6');
  });

  it('锁行 A$1：行固定，列随列偏移', () => {
    expect(shifted('=A$1+1', 2, 3)).toBe('=C$1+1');
    expect(shifted('=A$1', 5, 5)).toBe('=F$1');
  });

  it('全锁 $A$1：列与行都不动', () => {
    expect(shifted('=$A$1*2', 3, 4)).toBe('=$A$1*2');
    // 全锁：负偏移也不越界、两个引用都原地不动（小写规范化为大写）
    expect(shifted('=$A$1/$a$1', -5, -5)).toBe('=$A$1/$A$1');
  });

  it('一条公式内四种写法混合：各按各的锚定平移', () => {
    // 源 -> 右 1 下 1：A1->B2，$A1->$A2，A$1->B$1，$A$1 不动
    expect(shifted('=A1+$A1+A$1+$A$1', 1, 1)).toBe(
      '=B2+$A2+B$1+$A$1',
    );
  });

  it('非公式（空 / 整数）原样复制，不做平移', () => {
    expect(shifted('42', 1, 1)).toBe('42');
    expect(shifted('  -7 ', 1, 1)).toBe('  -7 ');
    expect(shifted('', 3, 3)).toBe('');
  });

  it('越界：任一引用超出 A..T / 1..20 即报告，不产出文本', () => {
    const r1 = translateCellRaw('=A1', -1, 0);
    expect('failures' in r1).toBe(true);
    if ('failures' in r1) expect(r1.failures[0].reason).toContain('列');

    const r2 = translateCellRaw('=A1', 0, -1);
    expect('failures' in r2).toBe(true);
    if ('failures' in r2) expect(r2.failures[0].reason).toContain('行');

    // 锁定的一维不参与越界判定
    expect(shifted('=$A1', -5, 0)).toBe('=$A1');
    expect(shifted('=A$1', 0, -5)).toBe('=A$1');
  });

  it('解析器直接接受三种 $ 锚定写法并按地址参与依赖求值', () => {
    const e = make({ A1: '3', B2: '=$A$1*2', C3: '=$A1+B$2' });
    expect(val(e, 'B2')).toBe('6');
    // 锚定只影响复制平移；求值目标仍是地址本身：
    // C3 的 $A1 即 A1=3，B$2 即 B2=6
    expect(val(e, 'C3')).toBe('9');
  });
});

/* ------------------------- 整组复制：语义 ------------------------- */

describe('矩形复制：矩形与写入计划', () => {
  it('2×3 矩形中每个目标格按源格到目标格的偏移平移', () => {
    const e = make({ C2: '=A1' });
    const p = preview(e, 'C2', 'D3', 2, 3);
    expect(p.ok).toBe(true);
    expect(p.plans.map((pl) => pl.target)).toEqual(['D3', 'E3', 'D4', 'E4', 'D5', 'E5']);
    const m = planMap(p);
    // 源 C2 -> D3：列 +1 行 +1，A1 -> B2
    expect(m.get('D3')).toBe('=B2');
    expect(m.get('E3')).toBe('=C2');
    expect(m.get('D4')).toBe('=B3');
    expect(m.get('E5')).toBe('=C4');
  });

  it('超过 5×5 整组拒绝，网格 / 修订号 / 导出不变', () => {
    const e = make({ A1: '=1+1' });
    const before = () => {
      const f = JSON.parse(exportSnapshot(e.getSnapshot())) as { revision: number };
      return { revision: f.revision };
    };
    expect(before()).toEqual({ revision: 1 });
    const p = preview(e, 'A1', 'B1', 6, 1);
    expect(p.ok).toBe(false);
    expect(p.errors!.join(' ')).toContain('5×5');
    expect(preview(e, 'A1', 'A1', 5, 6).ok).toBe(false);
    expect(e.getSnapshot().revision).toBe(1);
    expect(rawOf(e, 'B1')).toBe('');
    expect(before()).toEqual({ revision: 1 }); // 导出内容（修订号与网格）不变
  });

  it('矩形越出 T 列 / 20 行整组拒绝', () => {
    const e = make({ S1: '=1' });
    expect(preview(e, 'S1', 'S1', 3, 1).ok).toBe(false);
    expect(preview(e, 'A19', 'A19', 1, 3).ok).toBe(false);
  });

  it('非法源格 / 目标地址整组拒绝', () => {
    const e = make({ A1: '=1' });
    expect(preview(e, 'U1', 'A1', 1, 1).ok).toBe(false);
    expect(preview(e, 'A1', 'A21', 1, 1).ok).toBe(false);
  });

  it('任一目标格平移后引用越界：整组拒绝，网格、修订号与导出均不变', () => {
    // 源 B1 引用 A1；目标矩形 A1..B1 左扩：A1 相对源偏移列 -1，
    // 公式里的相对引用 A1 再随该偏移左移一列 => 越出 A 列，整组拒绝。
    const e = make({ B1: '=A1+1' });
    const beforeExport = JSON.parse(exportSnapshot(e.getSnapshot()));
    const p = preview(e, 'B1', 'A1', 2, 1);
    expect(p.ok).toBe(false);
    expect(p.outOfBounds![0].target).toBe('A1');
    expect(p.outOfBounds![0].failures[0].ref).toBe('A1');
    expect(e.getSnapshot().revision).toBe(1);
    expect(rawOf(e, 'A1')).toBe('');
    expect(rawOf(e, 'B1')).toBe('=A1+1');
    // 导出内容（去掉时间戳）完全不变
    const afterExport = JSON.parse(exportSnapshot(e.getSnapshot())) as Record<string, unknown>;
    delete (beforeExport as Record<string, unknown>).exportedAt;
    delete afterExport.exportedAt;
    expect(afterExport).toEqual(beforeExport);
  });
});

/* ------------------------- 重叠复制：冻结源快照 ------------------------- */

describe('矩形复制：源、目标重叠时先冻结完整源快照', () => {
  it('源格落在矩形内：源格自身零偏移保持原公式，其余格按各自偏移平移', () => {
    const e = make({ B2: '=A1' });
    // 目标 B2..C3，源在左上角
    const p = preview(e, 'B2', 'B2', 2, 2);
    expect(p.ok).toBe(true);
    const m = planMap(p);
    expect(m.get('B2')).toBe('=A1'); // 源格，公式不变
    expect(m.get('C2')).toBe('=B1');
    expect(m.get('B3')).toBe('=A2');
    expect(m.get('C3')).toBe('=B2');
    // isSource 标记
    const srcPlan = p.plans.find((pl) => pl.target === 'B2')!;
    expect(srcPlan.isSource).toBe(true);
  });

  it('源格零偏移时逐字保留原文（小写 / $ / 空白均不规范化重组）', () => {
    expect(shifted('=a1+$b$2', 0, 0)).toBe('=a1+$b$2');
    const e = make({ B2: '=a1+$b$2' });
    const p = preview(e, 'B2', 'B2', 2, 1);
    const m = planMap(p);
    expect(m.get('B2')).toBe('=a1+$b$2'); // 源格逐字不变
    expect(m.get('C2')).toBe('=B1+$B$2'); // 非源目标才做平移并规范化为大写
  });

  it('重叠 3 格横排：计划全部来自冻结源，绝不被“前面已写入的目标格”污染', () => {
    // 源 C1 = B1（相对引用前一格）。复制到 B1..D1（3×1，源在中间）。
    // 正确（冻结快照）：B1=>A1, C1=>B1(源,原样=B1), D1=>C1。
    // 若错误地顺序读取“当前”格：写到 B1 后再算 C1 会读到已写入的 =A1 而非源原文 =B1，
    // 平移链会整排退化成 =A1；冻结快照保证 D1 是 =C1。
    const e = make({ A1: '10', C1: '=B1' });
    const p = preview(e, 'C1', 'B1', 3, 1);
    expect(p.ok).toBe(true);
    const m = planMap(p);
    expect(m.get('B1')).toBe('=A1');
    expect(m.get('C1')).toBe('=B1');
    expect(m.get('D1')).toBe('=C1');

    const r = e.commitCopy(p);
    expect(r.ok).toBe(true);
    expect(rawOf(e, 'B1')).toBe('=A1');
    expect(rawOf(e, 'C1')).toBe('=B1');
    expect(rawOf(e, 'D1')).toBe('=C1');
    // 最终图一次性求值：A1=10，B1=A1=10，C1=B1=10，D1=C1=10
    expect(val(e, 'B1')).toBe('10');
    expect(val(e, 'C1')).toBe('10');
    expect(val(e, 'D1')).toBe('10');
  });

  it('复制到含旧内容的重叠矩形：旧目标内容不参与平移，只出现在“修改前”差异', () => {
    const e = make({ A1: '5', B1: '=A1', C1: '999' });
    const p = preview(e, 'B1', 'B1', 2, 1); // B1 源 + C1
    expect(planMap(p).get('C1')).toBe('=B1'); // 不读 C1 旧值 999
    const c1change = p.changes.find((c) => c.key === 'C1')!;
    expect(c1change.before.value!.toExactString()).toBe('999');
    expect(c1change.after.value!.toExactString()).toBe('5');
  });
});

/* ------------------------- 最终候选依赖图 ------------------------- */

describe('矩形复制：最终候选依赖图上的环、除零与传播', () => {
  it('复制在最终候选图上新生环：被覆盖的目标格变成自指，源格成为环下游', () => {
    // 源 A1 =$A$2（全锁到 A2），复制前 A2=7、A1=7，无环。
    // 复制到 A2（下移 1）：全锁两维都不动 => A2 仍 =$A$2，即引用自身，新生自环；
    // 源格 A1=$A$2 成为环下游，不再显示旧值 7。
    const e = make({ A2: '7', A1: '=$A$2' });
    expect(val(e, 'A1')).toBe('7');
    const p = preview(e, 'A1', 'A2', 1, 1);
    expect(p.ok).toBe(true);
    expect(planMap(p).get('A2')).toBe('=$A$2'); // 全锁不随偏移移动 => A2 自指
    expect(p.states.get('A2')!.error?.type).toBe('cycle');
    expect(p.states.get('A2')!.value).toBeNull();
    expect(p.states.get('A2')!.error?.cycle).toEqual(['A2', 'A2']);
    expect(p.states.get('A1')!.error?.type).toBe('cycle'); // 环下游不留旧值 7
    expect(p.states.get('A1')!.value).toBeNull();

    const r = e.commitCopy(p);
    expect(r.ok).toBe(true);
    expect(e.getSnapshot().states.get('A2')!.error?.type).toBe('cycle');
    expect(e.getSnapshot().states.get('A1')!.error?.type).toBe('cycle');
  });

  it('复制常量打断环：环与下游错误在最终图上消失', () => {
    const e = make({ A1: '=B1', B1: '=A1', C1: '=A1+1' });
    expect(e.getSnapshot().states.get('C1')!.error?.type).toBe('cycle');
    // 把数字 5 从 D1 复制到 B1（常量原样复制），断环
    e.setCell('D1', '5');
    const p = preview(e, 'D1', 'B1', 1, 1);
    expect(planMap(p).get('B1')).toBe('5');
    expect(p.states.get('A1')!.value!.toExactString()).toBe('5');
    expect(p.states.get('B1')!.value!.toExactString()).toBe('5');
    expect(p.states.get('C1')!.value!.toExactString()).toBe('6');
    e.commitCopy(p);
    expect(val(e, 'C1')).toBe('6');
  });

  it('复制新生除零：源公式锁行，复制到空目标后引用空格，错误按最终图传播', () => {
    // 源 B1 = A$1（锁行 1），复制前 A1=4，B1=1/... 实际 B1 只引用 A1。
    // 构造：B1 = 1/A$1（值 1/4，无错误）；向右复制到 C1：列偏移 +1、行锁定
    //   => C1 = 1/B$1 = 1/B1 = 4，无除零。
    // 要新生除零：让平移后引用到“空（0）”格。源 D1 = 1/C$1（C1=2 => 1/2）。
    // 复制到 E1：E1 = 1/D$1 = 1/D1 = 2，不空。
    // 正确构造：源 B1 = 1/A$1，目标矩形 A1..B1（源在右端）：
    //   A1 列偏移 -1、行锁定 => A1 = 1/A$1 = 1/A1 —— 自指（环），不是除零。
    // 用“复制公式到空列但不回指”：源 C1 = 1/A$1（A1=4）。目标只放 D1（右移 1）：
    //   D1 = 1/B$1，B1 为空按 0 => 除零；下游 E1=D1+2 同被传播。
    const e = make({ A1: '4', C1: '=1/A$1', E1: '=D1+2' });
    expect(val(e, 'C1')).toBe('1/4');
    const p = preview(e, 'C1', 'D1', 1, 1);
    expect(planMap(p).get('D1')).toBe('=1/B$1'); // B1 为空 -> 0
    expect(p.states.get('D1')!.error?.type).toBe('divzero');
    expect(p.states.get('D1')!.error?.source).toBe('D1');
    expect(p.states.get('E1')!.error?.type).toBe('divzero');
    expect(p.states.get('E1')!.error?.path).toEqual(['D1', 'E1']);
    // 未确认前正式网格不变：D1 仍为空，E1 引用空 D1(=0) 仍为 2
    expect(e.getSnapshot().states.has('D1')).toBe(false);
    expect(val(e, 'E1')).toBe('2');
  });

  it('只列出精确值 / 错误 / 来源路径真正变化的格', () => {
    const e = make({ A1: '3', B1: '=A1', C1: '=A1+0', Z1: '=9+9' });
    // 复制 B1(=A1) 到 D1：D1 也 =3；Z1=18 不受影响
    const p = preview(e, 'B1', 'D1', 1, 1);
    const keys = p.changes.map((c) => c.key);
    expect(keys).toContain('D1');
    expect(keys).not.toContain('Z1');
    expect(keys).not.toContain('A1');
  });
});

/* ------------------------- #ERR! 源格语义 ------------------------- */

describe('矩形复制：语法错误源格按 #ERR! 语义复制原文', () => {
  it('错误原文原样复制到每个目标，不做平移、不做越界拒绝', () => {
    const e = make({ A1: '=SUM(1)' }); // 既有 #ERR!
    expect(e.getSnapshot().states.get('A1')!.error?.type).toBe('parse');
    // 即便左扩会让“若强行平移”越界，原文复制也不拒绝
    const p = preview(e, 'A1', 'A1', 2, 2);
    expect(p.ok).toBe(true);
    for (const pl of p.plans) {
      expect(pl.raw).toBe('=SUM(1)');
    }
    e.commitCopy(p);
    for (const k of ['A1', 'B1', 'A2', 'B2']) {
      expect(rawOf(e, k)).toBe('=SUM(1)');
      expect(e.getSnapshot().states.get(k)!.error?.type).toBe('parse');
    }
  });

  it('错误公式复制后按最终图向下游传播', () => {
    const e = make({ A1: '=1+', B1: '=A1+2' });
    const p = preview(e, 'A1', 'C1', 1, 1);
    expect(p.states.get('C1')!.error?.type).toBe('parse');
    // 新建一个引用 C1 的格不在本次范围；只确认 C1 自身是 parse 错误源
    expect(p.states.get('C1')!.error?.source).toBe('C1');
    expect(p.states.get('B1')!.error?.type).toBe('parse'); // 旧下游不变
  });
});

/* ------------------------- 确认：一次性 / 过期 / 导出 ------------------------- */

describe('矩形复制：确认与过期保护', () => {
  it('确认只允许基于同一网格修订写入一次；第二次确认过期不落格', () => {
    const e = make({ A1: '1' });
    const p = preview(e, 'A1', 'B1', 1, 1);
    expect(e.commitCopy(p).ok).toBe(true);
    expect(e.getSnapshot().revision).toBe(2);
    expect(rawOf(e, 'B1')).toBe('1');
    const again = e.commitCopy(p);
    expect(again.ok).toBe(false);
    expect(again.stale).toBe(true);
    expect(e.getSnapshot().revision).toBe(2); // 不再递增
  });

  it('预览后正式网格被编辑：确认过期，保留正式数据', () => {
    const e = make({ A1: '1', C1: '=A1' });
    const p = preview(e, 'A1', 'B1', 1, 1);
    e.setCell('C1', '42'); // 期间发生真实修订
    const r = e.commitCopy(p);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(rawOf(e, 'B1')).toBe('');
    expect(val(e, 'C1')).toBe('42');
  });

  it('预演绝不写入正式网格、不递增修订号', () => {
    const e = make({ A1: '=B1', B1: '2' });
    const rev = e.getSnapshot().revision;
    const p = preview(e, 'A1', 'C1', 2, 2);
    expect(p.ok).toBe(true);
    expect(e.getSnapshot().revision).toBe(rev);
    expect(rawOf(e, 'C1')).toBe('');
    expect(rawOf(e, 'D2')).toBe('');
  });

  it('导入新网格使旧复制预览过期', () => {
    const e = make({ A1: '=1' });
    const p = preview(e, 'A1', 'B1', 1, 1);
    e.loadGrid({ X1: '42' });
    expect(e.commitCopy(p).stale).toBe(true);
    expect(e.getRaw('X1')).toBe('42');
    expect(e.getSnapshot().states.has('B1')).toBe(false);
  });

  it('导出只反映确认后的网格：未确认预览不出现，确认后保留锚定原文', () => {
    const e = make({ A1: '1', B1: '=$A$1+A$1+$A1' });
    expect(val(e, 'B1')).toBe('3'); // 求值只看地址：$A$1/A$1/$A1 都是 A1=1
    const p = preview(e, 'B1', 'C1', 1, 1); // 列 +1、行不变
    expect(exportSnapshot(e.getSnapshot())).not.toContain('C1');
    e.commitCopy(p);
    // $A$1 全锁；A$1 锁行：列 A->B；$A1 锁列：行不变
    const json = exportSnapshot(e.getSnapshot());
    expect(json).toContain('"raw": "=$A$1+B$1+$A1"');
    // C1 = $A$1(1) + B$1=B1(3) + $A1=A1(1) = 5
    expect(val(e, 'C1')).toBe('5');
  });
});

/* ------------------------- 与旧流程并存：JSON 导入 ------------------------- */

describe('矩形复制：JSON 导入与锚定公式并存', () => {
  it('带 $ 锚定的 raw 通过严格校验，导出再导入后原文与求值一致', () => {
    const e = make({
      A1: '2',
      B1: '=$A$1*3',
      C1: '=B$1+$A1',
      D1: '=A1+$A1+A$1+$A$1',
    });
    expect(val(e, 'B1')).toBe('6');
    expect(val(e, 'C1')).toBe('8'); // B1(6) + A1(2)
    expect(val(e, 'D1')).toBe('8');

    const json = exportSnapshot(e.getSnapshot());
    const result = validateImport(json);
    expect(result.ok).toBe(true);
    const e2 = new SheetEngine();
    e2.loadGrid(result.cells!);
    expect(e2.getRaw('B1')).toBe('=$A$1*3');
    expect(val(e2, 'B1')).toBe('6');
    expect(val(e2, 'C1')).toBe('8');
    expect(val(e2, 'D1')).toBe('8');
  });

  it('非法锚定写法的 raw 整份拒绝', () => {
    for (const bad of ['=$1+1', '=A$+1', '=$U1', '=$A$21']) {
      const r = validateImport(
        JSON.stringify({
          format: 'onsite-sheet',
          version: 1,
          cells: [{ addr: 'A1', raw: bad }],
        }),
      );
      expect(r.ok, bad).toBe(false);
    }
  });
});
