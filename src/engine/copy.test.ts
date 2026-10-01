import { describe, expect, it } from 'vitest';
import { SheetEngine, type CopyPreview } from './engine';
import { exportSnapshot, validateImport } from './snapshot';

function make(cells: Record<string, string>): SheetEngine {
  const e = new SheetEngine();
  e.loadGrid(cells);
  return e;
}

function val(e: SheetEngine, addr: string): string | null {
  return e.getSnapshot().states.get(addr)?.value?.toExactString() ?? null;
}

function err(e: SheetEngine, addr: string) {
  return e.getSnapshot().states.get(addr)?.error ?? null;
}

function raw(e: SheetEngine, addr: string): string {
  return e.getSnapshot().raw.get(addr) ?? '';
}

function plan(p: CopyPreview): Map<string, string> {
  return new Map(p.cells.map((c) => [c.target, c.targetRaw]));
}

describe('矩形复制：四种锚定写法的引用转换', () => {
  it('A1 相对、$A1 锁列、A$1 锁行、$A$1 全锁：从 B2 复制到 C4（dc=1, dr=2）', () => {
    const e = make({
      A1: '7',
      B2: '=A1+$A1+A$1+$A$1',
    });
    const p = e.previewCopy({
      sourceTopLeft: 'B2',
      targetTopLeft: 'C4',
      width: 1,
      height: 1,
    });
    expect(p.ok).toBe(true);
    expect(plan(p).get('C4')).toBe('=B3+$A3+B$1+$A$1');
  });

  it('小写引用与锚标记一并规范化（$a2 -> $B4 等按锚定规则平移）', () => {
    const e = make({ B2: '=a2+$a2+a$2+$a$2' });
    const p = e.previewCopy({
      sourceTopLeft: 'B2',
      targetTopLeft: 'C3',
      width: 1,
      height: 1,
    });
    expect(p.ok).toBe(true);
    expect(plan(p).get('C3')).toBe('=B3+$A3+B$2+$A$2');
  });

  it('多引用混合：未锚定引用随格移动，锚定部分原地不动', () => {
    const e = make({ A1: '1', C3: '=A1*2+$A$1/3+B5-$B5' });
    const p = e.previewCopy({
      sourceTopLeft: 'C3',
      targetTopLeft: 'E5',
      width: 1,
      height: 1,
    });
    expect(p.ok).toBe(true);
    // dc=2 dr=2：A1->C3、$A$1 不动、B5->D7、$B5 锁列 => $B7
    expect(plan(p).get('E5')).toBe('=C3*2+$A$1/3+D7-$B7');
  });

  it('整数与空格不做任何转换', () => {
    const e = make({ A1: '42', B1: '-7' });
    const p = e.previewCopy({
      sourceTopLeft: 'A1',
      targetTopLeft: 'T19',
      width: 1,
      height: 2,
    });
    expect(p.ok).toBe(true);
    expect(plan(p).get('T19')).toBe('42');
    const a2 = p.cells.find((c) => c.source === 'A2')!;
    expect(a2.target).toBe('T20');
    expect(a2.targetRaw).toBe('');
  });
});

describe('矩形复制：几何限制', () => {
  it('宽高必须为 1～5；源 / 目标矩形越界整组拒绝', () => {
    const e = make({ A1: '1' });
    expect(e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'C3', width: 0, height: 1 }).ok).toBe(false);
    expect(e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'C3', width: 6, height: 1 }).ok).toBe(false);
    expect(e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'C3', width: 1.5, height: 1 }).ok).toBe(false);
    const rev = e.getSnapshot().revision;
    // 5×5 源矩形从 R16 起放不下
    const p = e.previewCopy({ sourceTopLeft: 'R16', targetTopLeft: 'A1', width: 5, height: 5 });
    expect(p.ok).toBe(false);
    expect(p.errors!.join(' ')).toContain('超出网格');
    // 目标 5×5 从 R1 起也放不下
    const p2 = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'R1', width: 5, height: 5 });
    expect(p2.ok).toBe(false);
    expect(e.getSnapshot().revision).toBe(rev);
  });

  it('非法起始地址整组拒绝', () => {
    const e = make({ A1: '1' });
    expect(e.previewCopy({ sourceTopLeft: 'U1', targetTopLeft: 'B1', width: 1, height: 1 }).ok).toBe(false);
    expect(e.previewCopy({ sourceTopLeft: 'A21', targetTopLeft: 'B1', width: 1, height: 1 }).ok).toBe(false);
  });
});

describe('矩形复制：越界引用整组拒绝', () => {
  it('相对引用平移后越过左边界：整组拒绝且网格、修订号、导出均不变', () => {
    const e = make({ B1: '=A1+1' });
    const cellsBefore = JSON.parse(exportSnapshot(e.getSnapshot())).cells;
    const p = e.previewCopy({ sourceTopLeft: 'B1', targetTopLeft: 'A1', width: 1, height: 1 });
    expect(p.ok).toBe(false);
    expect(p.errors!.join(' ')).toContain('A1');
    expect(p.cells).toEqual([]);
    expect(e.getSnapshot().revision).toBe(1);
    expect(raw(e, 'A1')).toBe('');
    expect(raw(e, 'B1')).toBe('=A1+1');
    expect(JSON.parse(exportSnapshot(e.getSnapshot())).cells).toEqual(cellsBefore);
  });

  it('相对引用平移后越过下边界：整组拒绝', () => {
    const e = make({ A19: '=A20' });
    const p = e.previewCopy({ sourceTopLeft: 'A19', targetTopLeft: 'A20', width: 1, height: 1 });
    expect(p.ok).toBe(false);
    expect(p.errors!.join(' ')).toContain('A20');
  });

  it('锚定引用不参与平移：$A$1 复制到任何格都不越界', () => {
    const e = make({ A1: '9', B1: '=$A$1+1' });
    const p = e.previewCopy({ sourceTopLeft: 'B1', targetTopLeft: 'T20', width: 1, height: 1 });
    expect(p.ok).toBe(true);
    expect(plan(p).get('T20')).toBe('=$A$1+1');
  });

  it('锁行 $ 锚使行不越界、锁列 $ 锚使列不越界', () => {
    const e = make({ A1: '=A20+$A20+A$20' });
    // 下移 1：A20 越行、$A20 锁列但行仍相对也越行、A$20 锁行不越
    const pDown = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'A2', width: 1, height: 1 });
    expect(pDown.ok).toBe(false);
    expect(pDown.errors!.join(' ')).toContain('A20');
    expect(pDown.errors!.join(' ')).toContain('$A20');
    expect(pDown.errors!.join(' ')).not.toContain('A$20');
    // 右移 1：A20 越列成 B20？不，A1->B1 时列 +1：A20->B20 不越；$A20 锁列 $A 不越；
    // A$20 的列相对 => B$20 不越
    const pRight = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'B1', width: 1, height: 1 });
    expect(pRight.ok).toBe(true);
    expect(plan(pRight).get('B1')).toBe('=B20+$A20+B$20');
  });

  it('多格矩形中任一格越界即整组拒绝（不会只写一部分）', () => {
    const e = make({ B1: '=A1', B2: '=A2+A1' });
    // 2×2 源矩形从 B1 左移到 A1：B 列格内对 A 列的相对引用平移后越出左边界
    const p = e.previewCopy({ sourceTopLeft: 'B1', targetTopLeft: 'A1', width: 1, height: 2 });
    expect(p.ok).toBe(false);
    expect(p.cells).toEqual([]);
    expect(raw(e, 'A1')).toBe('');
    expect(raw(e, 'A2')).toBe('');
  });
});

describe('矩形复制：重叠复制必须基于冻结的源快照', () => {
  it('整行右移一格：源格依次转换，不被已写入的目标格污染', () => {
    // A1=1, B1=A1, C1=B1；向右复制一格，目标 B1..D1。
    // 若按写入顺序就地改写：B1 会读到“新 A1？”——这里源 B1=A1 平移为 B1（自环），
    // 正确语义基于冻结快照：B1<-原A1的转换(=B? ) 见下断言逐一核对。
    const e = make({ A1: '1', B1: '=A1', C1: '=B1' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'B1', width: 3, height: 1 });
    expect(p.ok).toBe(true);
    // 源 A1（整数 1）-> B1
    expect(plan(p).get('B1')).toBe('1');
    // 源 B1 =A1（dc=1）-> C1 为 =B1，依据是冻结的源 B1，而非已写入的 B1=1 文本
    expect(plan(p).get('C1')).toBe('=B1');
    // 源 C1 =B1（dc=1）-> D1 为 =C1
    expect(plan(p).get('D1')).toBe('=C1');
    // 采纳后：B1=1，C1=B1=1，D1=C1=1，A1 仍为 1
    const r = e.commitCopy(p);
    expect(r.ok).toBe(true);
    expect(raw(e, 'B1')).toBe('1');
    expect(raw(e, 'C1')).toBe('=B1');
    expect(raw(e, 'D1')).toBe('=C1');
    expect(val(e, 'D1')).toBe('1');
    expect(val(e, 'A1')).toBe('1');
  });

  it('整列下移一格：逐格公式按冻结源转换，结果沿新位置传播', () => {
    const e = make({ A1: '2', A2: '=A1*10', A3: '=A2+1' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'A2', width: 1, height: 3 });
    expect(p.ok).toBe(true);
    expect(plan(p).get('A2')).toBe('2');
    // 源 A2 =A1*10 下移一行（dr=1）-> A3 为 =A2*10（依据冻结源，而非已写入的 A2=2）
    expect(plan(p).get('A3')).toBe('=A2*10');
    // 源 A3 =A2+1 -> A4 为 =A3+1
    expect(plan(p).get('A4')).toBe('=A3+1');
    expect(e.commitCopy(p).ok).toBe(true);
    // A2 被覆盖为 2；A3=A2*10=20；A4=A3+1=21
    expect(val(e, 'A2')).toBe('2');
    expect(val(e, 'A3')).toBe('20');
    expect(val(e, 'A4')).toBe('21');
    // 源 A1 在矩形外保持原样
    expect(val(e, 'A1')).toBe('2');
  });

  it('源矩形中的空格清空重叠目标格，但不影响矩形外的格', () => {
    const e = make({ A1: '1', A2: '3', B2: '9' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'B1', width: 2, height: 1 });
    expect(p.ok).toBe(true);
    expect(plan(p).get('B1')).toBe('1');
    // 源 B1 为空 -> 目标 C1 清空
    expect(plan(p).get('C1')).toBe('');
    expect(e.commitCopy(p).ok).toBe(true);
    expect(raw(e, 'B1')).toBe('1');
    expect(raw(e, 'C1')).toBe('');
    expect(raw(e, 'B2')).toBe('9'); // 矩形外不动
  });
});

describe('矩形复制：#ERR! 源格按原文复制', () => {
  it('语法错误的源格不做转换、原文照搬，目标格同样为 #ERR! 并向下游传播', () => {
    const e = make({ A1: '=1+', B1: '=A1+2' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'D1', width: 2, height: 1 });
    expect(p.ok).toBe(true);
    const d1 = p.cells.find((c) => c.target === 'D1')!;
    expect(d1.parseError).toBe(true);
    expect(d1.targetRaw).toBe('=1+');
    // 源 B1 合法，正常平移：=A1+2 -> =D1+2
    expect(plan(p).get('E1')).toBe('=D1+2');
    expect(p.states.get('D1')!.error?.type).toBe('parse');
    expect(p.states.get('E1')!.error?.type).toBe('parse');
    e.commitCopy(p);
    expect(err(e, 'D1')!.type).toBe('parse');
    expect(err(e, 'E1')!.type).toBe('parse');
    expect(err(e, 'E1')!.source).toBe('D1');
    // 源格原样保留
    expect(raw(e, 'A1')).toBe('=1+');
  });
});

describe('矩形复制：最终候选依赖图上的环、除零与传播', () => {
  it('复制互引公式到新位置：新位置成环，预览标出新环且不显示旧值', () => {
    const e = make({ A1: '=B1', B1: '=A1', C1: '5' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'D1', width: 2, height: 1 });
    expect(p.ok).toBe(true);
    expect(p.states.get('D1')!.error?.type).toBe('cycle');
    expect(p.states.get('E1')!.error?.type).toBe('cycle');
    expect(p.states.get('D1')!.value).toBeNull();
    const changed = new Set(p.changes.map((c) => c.key));
    expect(changed).toEqual(new Set(['D1', 'E1']));
    // 预演不写正式网格
    expect(err(e, 'D1')).toBeNull();
  });

  it('复制覆盖环的一条边可断环：旧环格出现在变化中且恢复数值', () => {
    // A1<->B1 成环，D1=A1+1 为环下游；把常量 C1=7 复制到 B1 打断环
    const e = make({ A1: '=B1', B1: '=A1', C1: '7', D1: '=A1+1' });
    expect(err(e, 'D1')!.type).toBe('cycle');
    const p = e.previewCopy({ sourceTopLeft: 'C1', targetTopLeft: 'B1', width: 1, height: 1 });
    expect(p.ok).toBe(true);
    expect(p.states.get('B1')!.value!.toExactString()).toBe('7');
    expect(p.states.get('A1')!.value!.toExactString()).toBe('7');
    expect(p.states.get('D1')!.value!.toExactString()).toBe('8');
    for (const k of ['A1', 'B1', 'D1']) {
      expect(p.states.get(k)!.error).toBeNull();
    }
    e.commitCopy(p);
    expect(val(e, 'A1')).toBe('7');
    expect(val(e, 'D1')).toBe('8');
  });

  it('复制新生除零：最终图上重算来源与传播路径', () => {
    const e = make({ A1: '4', B1: '=1/A1', C1: '=B1+1' });
    // 把 0 复制到 A1
    const p = e.previewCopy({ sourceTopLeft: 'D1', targetTopLeft: 'A1', width: 1, height: 1 });
    // 源 D1 为空 => 目标 A1 被清空（空格按 0），B1 新生除零
    expect(p.ok).toBe(true);
    expect(p.states.get('B1')!.error?.type).toBe('divzero');
    expect(p.states.get('C1')!.error?.type).toBe('divzero');
    expect(p.states.get('C1')!.error?.path).toEqual(['B1', 'C1']);
  });

  it('采纳后导出 JSON 反映复制结果（含锚定原文与环标记），且可再次导入', () => {
    const e = make({ A1: '1', B1: '=A1+$A$1' });
    const p = e.previewCopy({ sourceTopLeft: 'B1', targetTopLeft: 'C2', width: 1, height: 1 });
    expect(p.ok).toBe(true);
    e.commitCopy(p);
    const json = exportSnapshot(e.getSnapshot());
    expect(json).toContain('"raw": "=B2+$A$1"');
    const reimport = validateImport(json);
    expect(reimport.ok).toBe(true);
    // 导入后锚定公式照常求值：C2 = B2（空=0）+ $A$1(1) = 1
    const e2 = new SheetEngine();
    e2.loadGrid(reimport.cells!);
    expect(val(e2, 'C2')).toBe('1');
    expect(raw(e2, 'C2')).toBe('=B2+$A$1');
  });

  it('旧流程不受影响：单格编辑、JSON 导入导出、1～3 格假设修改都接受锚定公式', () => {
    const e = new SheetEngine();
    e.setCell('A1', '5');
    e.setCell('B1', '=$A$1*2+$A1-A$1');
    expect(val(e, 'B1')).toBe('10');
    const json = exportSnapshot(e.getSnapshot());
    const reimport = validateImport(json);
    expect(reimport.ok).toBe(true);
    const hp = e.previewHypothesis([{ addr: 'A1', raw: '6' }]);
    expect(hp.ok).toBe(true);
    expect(hp.states.get('B1')!.value!.toExactString()).toBe('12');
    // 非法锚定写法仍是解析错误（不是候选非法），按 #ERR! 语义
    const hp2 = e.previewHypothesis([{ addr: 'C1', raw: '=A$' }]);
    expect(hp2.ok).toBe(true);
    expect(hp2.states.get('C1')!.error?.type).toBe('parse');
  });
});

describe('矩形复制：确认只允许基于同一修订写入一次', () => {
  it('预演后正式网格被改动：确认过期、整组不写入', () => {
    const e = make({ A1: '1', B1: '=A1+1' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'C1', width: 1, height: 1 });
    e.setCell('A1', '100');
    const r = e.commitCopy(p);
    expect(r.ok).toBe(false);
    expect(r.stale).toBe(true);
    expect(raw(e, 'C1')).toBe('');
    expect(val(e, 'B1')).toBe('101');
  });

  it('同一预演不得重复采纳（采纳即产生新修订）', () => {
    const e = make({ A1: '1' });
    const p = e.previewCopy({ sourceTopLeft: 'A1', targetTopLeft: 'B1', width: 1, height: 1 });
    expect(e.commitCopy(p).ok).toBe(true);
    const again = e.commitCopy(p);
    expect(again.ok).toBe(false);
    expect(again.stale).toBe(true);
  });

  it('被拒绝的预演不递增修订号，也不改变导出', () => {
    const e = make({ B1: '=A1' });
    const cellsBefore = JSON.parse(exportSnapshot(e.getSnapshot())).cells;
    const p = e.previewCopy({ sourceTopLeft: 'B1', targetTopLeft: 'A1', width: 1, height: 1 });
    expect(p.ok).toBe(false);
    expect(e.getSnapshot().revision).toBe(1);
    expect(JSON.parse(exportSnapshot(e.getSnapshot())).cells).toEqual(cellsBefore);
  });
});
