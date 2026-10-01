import { useMemo, useState } from 'react';
import { colToLetter, parseAddr, type Addr } from '../engine/cells';
import type { CellCopyPlan, CopyPreview } from '../engine/engine';
import type { CopyRequest } from '../engine/fill';
import { ChangesTable, OutcomeView } from './outcome';

interface CopyPanelProps {
  revision: number;
  initialAddr: Addr;
  /** 基于当前正式快照预演矩形复制（不会修改正式网格） */
  onPreview: (req: CopyRequest) => CopyPreview;
  /** 一次性写入整个矩形；返回 false 表示预演已过期 */
  onCommit: (preview: CopyPreview) => boolean;
  onCancel: () => void;
  onJump: (addr: Addr) => void;
}

export function CopyPanel({
  revision,
  initialAddr,
  onPreview,
  onCommit,
  onCancel,
  onJump,
}: CopyPanelProps) {
  const [source, setSource] = useState(initialAddr);
  const [topLeft, setTopLeft] = useState(initialAddr);
  const [width, setWidth] = useState('1');
  const [height, setHeight] = useState('1');
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [rejectErrors, setRejectErrors] = useState<string[] | null>(null);

  const touch = () => {
    // 任何输入改动都作废旧预览，避免过期预览与表单不一致
    setPreview(null);
    setRejectErrors(null);
  };

  const runPreview = () => {
    const errs: string[] = [];
    const w = Number(width);
    const h = Number(height);
    if (!Number.isInteger(w) || !Number.isInteger(h) || w < 1 || h < 1) {
      errs.push('矩形宽、高必须是 1～5 的整数');
    } else if (w > 5 || h > 5) {
      errs.push(`矩形至多 5×5 格（当前 ${w}×${h}）`);
    }
    if (errs.length > 0) {
      setRejectErrors(errs);
      setPreview(null);
      return;
    }
    const p = onPreview({ source: source.trim(), targetTopLeft: topLeft.trim(), width: w, height: h });
    if (!p.ok) {
      setRejectErrors(p.errors ?? ['复制已被整组拒绝']);
      setPreview(null);
      return;
    }
    setPreview(p);
  };

  const stale = preview !== null && preview.baseRevision !== revision;

  // 先行后列的计划表，供矩形预览定位
  const planAt = useMemo(() => {
    const m = new Map<Addr, CellCopyPlan>();
    preview?.plans.forEach((p) => m.set(p.target, p));
    return m;
  }, [preview]);

  const adopt = () => {
    if (!preview) return;
    if (onCommit(preview)) {
      onCancel(); // 写入成功，关闭工作区
    }
    // 过期时 onCommit 返回 false：保留预演，面板显示过期提示
  };

  const tl = preview ? parseAddr(preview.topLeft) : null;

  return (
    <div className="hyp-panel copy-panel">
      <div className="hyp-head">
        <h2>矩形复制工作区</h2>
        <span className="hyp-sub">
          已核对源格复制到至多 5×5 目标矩形 · $A$1 / $A1 / A$1 锚定保持 ·
          基于正式网格 r{revision} 一次性求值
        </span>
        <button className="btn hyp-close" onClick={onCancel} title="取消并关闭">
          ✕
        </button>
      </div>

      <table className="hyp-input-table copy-input-table">
        <tbody>
          <tr>
            <td className="hyp-col-addr">
              <label>源格</label>
            </td>
            <td>
              <input
                className="hyp-addr-input"
                value={source}
                placeholder="A1"
                onChange={(e) => {
                  setSource(e.target.value);
                  touch();
                }}
              />
            </td>
          </tr>
          <tr>
            <td className="hyp-col-addr">
              <label>目标左上角</label>
            </td>
            <td>
              <input
                className="hyp-addr-input"
                value={topLeft}
                placeholder="B1"
                onChange={(e) => {
                  setTopLeft(e.target.value);
                  touch();
                }}
              />
            </td>
          </tr>
          <tr>
            <td className="hyp-col-addr">
              <label>宽 × 高（格，≤5）</label>
            </td>
            <td className="copy-size-row">
              <input
                className="copy-size-input"
                value={width}
                aria-label="矩形宽度（列数）"
                onChange={(e) => {
                  setWidth(e.target.value);
                  touch();
                }}
              />
              <span>×</span>
              <input
                className="copy-size-input"
                value={height}
                aria-label="矩形高度（行数）"
                onChange={(e) => {
                  setHeight(e.target.value);
                  touch();
                }}
              />
            </td>
          </tr>
        </tbody>
      </table>

      <div className="hyp-actions">
        <button className="btn primary" onClick={runPreview}>
          生成复制预览
        </button>
        {preview && (
          <button className="btn" onClick={adopt} disabled={stale}>
            确认写入矩形
          </button>
        )}
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        {preview && (
          <span className="hyp-stat">
            {preview.plans.length} 格待写入 · {preview.changes.length} 格结果变化
            {preview.baseRevision === revision ? ` · 依据 r${preview.baseRevision}` : ''}
          </span>
        )}
      </div>

      {rejectErrors && (
        <div className="hyp-reject">
          <b>复制已整组拒绝，正式网格、修订号与导出均未改动：</b>
          {rejectErrors.map((m, i) => (
            <div key={i}>• {m}</div>
          ))}
        </div>
      )}

      {preview && stale && (
        <div className="hyp-stale">
          <b>预览已过期：</b>
          预览依据修订 r{preview.baseRevision}，正式网格已变为 r{revision}
          （发生过单格编辑、导入或采纳过其他预演）。请重新生成预览后再确认；正式数据保持不变。
        </div>
      )}

      {preview && !stale && tl && (
        <div className="hyp-results">
          <div className="copy-rect-wrap">
            <table className="copy-rect">
              <thead>
                <tr>
                  <th className="copy-corner">
                    {preview.source} →
                  </th>
                  {Array.from({ length: preview.width }, (_, dc) => (
                    <th key={dc}>{colToLetter(tl.col + dc)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: preview.height }, (_, dr) => (
                  <tr key={dr}>
                    <td className="copy-rowhead">{tl.row + dr + 1}</td>
                    {Array.from({ length: preview.width }, (_, dc) => {
                      const addr = `${colToLetter(tl.col + dc)}${tl.row + dr + 1}` as Addr;
                      const plan = planAt.get(addr);
                      const after = preview.states.get(addr);
                      const changed = preview.changes.some((c) => c.key === addr);
                      const cls = [
                        'copy-cell',
                        plan?.isSource ? 'copy-cell-source' : '',
                        changed ? 'copy-cell-changed' : '',
                        after?.error ? `copy-cell-err copy-cell-${after.error.type}` : '',
                      ]
                        .filter(Boolean)
                        .join(' ');
                      return (
                        <td key={dc} className={cls} onClick={() => onJump(addr)} title={`跳转到 ${addr}`}>
                          <div className="copy-cell-addr">{addr}</div>
                          <div className="copy-cell-raw">{plan?.raw || '（清空）'}</div>
                          <div className="copy-cell-out">
                            <OutcomeView
                              o={{
                                key: addr,
                                kind: after?.kind ?? null,
                                value: after?.value ?? null,
                                error: after?.error ?? null,
                              }}
                            />
                          </div>
                        </td>
                      );
                    })}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="copy-legend">
            <span className="copy-tag copy-cell-source-tag">源格</span> 源格自身（零偏移） ·{' '}
            <span className="copy-tag copy-cell-changed-tag">变化</span> 精确值 / 错误 /
            路径变化 · 悬停查看写入的原文，点击格可跳转
          </div>

          {preview.changes.length === 0 ? (
            <div className="hyp-nochange">整组复制不会改变任何格的精确值、错误或来源路径。</div>
          ) : (
            <>
              <h3 className="copy-diff-title">
                最终候选依赖图上的传播结果（新生 / 消失的环、除零与下游变化）
              </h3>
              <ChangesTable changes={preview.changes} onJump={onJump} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
