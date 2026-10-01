import type { CellOutcome } from '../engine/engine';

/** 错误结果的网格标记文字（#ERR! / #CYCLE! / #DIV/0!） */
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
