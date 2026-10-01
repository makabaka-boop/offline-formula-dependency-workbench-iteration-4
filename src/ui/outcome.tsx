import type { Addr } from '../engine/cells';
import type { CellChange, CellOutcome } from '../engine/engine';

export function errorCode(t: CellOutcome['error']): string {
  switch (t!.type) {
    case 'parse':
      return '#ERR!';
    case 'cycle':
      return '#CYCLE!';
    case 'divzero':
      return '#DIV/0!';
  }
}

export function OutcomeView({ o }: { o: CellOutcome }) {
  if (o.error) {
    return (
      <span className={`hyp-err hyp-err-${o.error.type}`} title={o.error.message}>
        {errorCode(o.error)}
      </span>
    );
  }
  if (o.value) {
    return <span className="hyp-num">{o.value.toDisplayString()}</span>;
  }
  return <span className="hyp-empty">（空）</span>;
}

export function PathView({ o }: { o: CellOutcome }) {
  if (!o.error) return null;
  const seq = o.error.cycle ?? o.error.path;
  if (seq.length <= 1) {
    return <span className="hyp-path">来源 {o.error.source}</span>;
  }
  return (
    <span className="hyp-path">
      {o.error.type === 'cycle' ? '环：' : '来源路径：'}
      {seq.join(' → ')}
    </span>
  );
}

/** 预演结果差异表：假设修改与矩形复用时共用（最终候选依赖图上的变化） */
export function ChangesTable({
  changes,
  onJump,
}: {
  changes: CellChange[];
  onJump: (addr: Addr) => void;
}) {
  return (
    <table className="hyp-diff-table">
      <thead>
        <tr>
          <th>格</th>
          <th>修改前</th>
          <th>预演后</th>
          <th>错误来源 / 环路径</th>
        </tr>
      </thead>
      <tbody>
        {changes.map((c) => {
          const a = c.after;
          return (
            <tr
              key={c.key}
              className={a.error ? `hyp-row-${a.error.type}` : ''}
              onClick={() => onJump(c.key)}
              title={`跳转到 ${c.key}`}
            >
              <td className="hyp-cell-key">{c.key}</td>
              <td className="hyp-cell-out">
                <OutcomeView o={c.before} />
              </td>
              <td className="hyp-cell-out">
                <OutcomeView o={a} />
              </td>
              <td className="hyp-cell-path">
                <PathView o={a} />
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
