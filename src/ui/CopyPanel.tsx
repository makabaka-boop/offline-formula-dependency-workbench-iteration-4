import { useState } from 'react';
import {
  colToLetter,
  normalizeRef,
  parseAddr,
  type Addr,
} from '../engine/cells';
import type { CopyPreview } from '../engine/engine';
import { OutcomeView, PathView } from './outcome';

interface CopyPanelProps {
  revision: number;
  initialAddr: Addr;
  /** 基于当前正式快照预演矩形复制（不会修改正式网格） */
  onPreview: (req: {
    sourceTopLeft: string;
    targetTopLeft: string;
    width: number;
    height: number;
  }) => CopyPreview;
  /** 一次性写入；返回 false 表示预演已过期 */
  onCommit: (preview: CopyPreview) => boolean;
  onCancel: () => void;
  onJump: (addr: Addr) => void;
}

function parseDim(v: string): number | null {
  if (!/^\d+$/.test(v.trim())) return null;
  return Number(v.trim());
}

export function CopyPanel({
  revision,
  initialAddr,
  onPreview,
  onCommit,
  onCancel,
  onJump,
}: CopyPanelProps) {
  const [src, setSrc] = useState(initialAddr);
  const [dst, setDst] = useState('');
  const [w, setW] = useState('1');
  const [h, setH] = useState('1');
  const [preview, setPreview] = useState<CopyPreview | null>(null);
  const [rejectErrors, setRejectErrors] = useState<string[] | null>(null);

  const invalidate = () => {
    setPreview(null);
    setRejectErrors(null);
  };

  const runPreview = () => {
    const errs: string[] = [];
    const width = parseDim(w);
    const height = parseDim(h);
    if (width === null || height === null) {
      errs.push('宽、高必须是 1～5 的整数');
    }
    if (!normalizeRef(src.trim())) errs.push(`源起始格 ${src} 超出 A1..T20`);
    if (!normalizeRef(dst.trim())) errs.push(`目标起始格 ${dst || '（空）'} 超出 A1..T20`);
    if (errs.length > 0) {
      setRejectErrors(errs);
      setPreview(null);
      return;
    }
    const p = onPreview({
      sourceTopLeft: src.trim(),
      targetTopLeft: dst.trim(),
      width: width!,
      height: height!,
    });
    if (!p.ok) {
      setRejectErrors(p.errors ?? ['复制被整组拒绝']);
      setPreview(null);
      return;
    }
    setRejectErrors(null);
    setPreview(p);
  };

  const stale = preview !== null && preview.baseRevision !== revision;

  // 在最终候选依赖图上汇总：新增 / 消失的环、除零（含传播变化逐格列出）
  const summarize = (p: CopyPreview) => {
    const appeared: string[] = [];
    const gone: string[] = [];
    for (const c of p.changes) {
      const bt = c.before.error?.type ?? null;
      const at = c.after.error?.type ?? null;
      if (bt !== at) {
        if (at === 'cycle' || at === 'divzero') appeared.push(`${c.key} ${at === 'cycle' ? '#CYCLE!' : '#DIV/0!'}`);
        if (bt === 'cycle' || bt === 'divzero') gone.push(`${c.key} ${bt === 'cycle' ? '#CYCLE!' : '#DIV/0!'}`);
      }
    }
    return { appeared, gone };
  };
  const summary = preview && !stale ? summarize(preview) : null;

  const adopt = () => {
    if (!preview) return;
    if (onCommit(preview)) onCancel(); // 写入成功，关闭工作区
    // 过期时 onCommit 返回 false：保留预演，面板显示过期提示
  };

  const targetOrigin = preview ? parseAddr(preview.cells[0].target) : null;

  return (
    <div className="hyp-panel copy-panel">
      <div className="hyp-head">
        <h2>矩形复制工作区</h2>
        <span className="hyp-sub">
          至多 5×5 · 相对引用随目标移动，$A$1 / $A1 / A$1 锚定保持不动 ·
          重叠复制先冻结源快照 · 基于 r{revision} 一次性求值
        </span>
        <button className="btn hyp-close" onClick={onCancel} title="取消并关闭">
          ✕
        </button>
      </div>

      <div className="copy-form">
        <label>
          源起始格
          <input
            className="hyp-addr-input copy-input"
            value={src}
            placeholder="A1"
            onChange={(e) => {
              setSrc(e.target.value);
              invalidate();
            }}
          />
        </label>
        <label>
          宽
          <input
            className="copy-dim-input"
            value={w}
            onChange={(e) => {
              setW(e.target.value);
              invalidate();
            }}
          />
        </label>
        <span className="copy-x">×</span>
        <label>
          高
          <input
            className="copy-dim-input"
            value={h}
            onChange={(e) => {
              setH(e.target.value);
              invalidate();
            }}
          />
        </label>
        <span className="copy-arrow">→</span>
        <label>
          目标起始格
          <input
            className="hyp-addr-input copy-input"
            value={dst}
            placeholder="C3"
            onChange={(e) => {
              setDst(e.target.value);
              invalidate();
            }}
          />
        </label>
        <button className="btn primary" onClick={runPreview}>
          预演复制
        </button>
      </div>

      <div className="hyp-actions">
        {preview && (
          <button className="btn" onClick={adopt} disabled={stale}>
            确认写入全部 {preview.cells.length} 格
          </button>
        )}
        <button className="btn" onClick={onCancel}>
          取消
        </button>
        {preview && (
          <span className="hyp-stat">
            {preview.width}×{preview.height} 矩形 · {preview.changes.length} 格结果变化
            {preview.baseRevision === revision ? ` · 依据 r${preview.baseRevision}` : ''}
          </span>
        )}
      </div>

      {rejectErrors && (
        <div className="hyp-reject">
          <b>整组复制已拒绝，正式网格、修订号与导出均未改动：</b>
          {rejectErrors.map((m, i) => (
            <div key={i}>• {m}</div>
          ))}
        </div>
      )}

      {preview && stale && (
        <div className="hyp-stale">
          <b>预演已过期：</b>
          预演依据修订 r{preview.baseRevision}，正式网格已变为 r{revision}
          （发生过单格编辑、导入或采纳其他预演）。请取消后基于当前网格重新预演；
          过期预演不能覆盖后续编辑，正式数据保持不变。
        </div>
      )}

      {preview && !stale && targetOrigin && (
        <div className="copy-results">
          <div className="copy-preview-head">
            目标矩形预览（公式为转换后原文，格内为最终候选依赖图的求值结果）
          </div>
          <div className="copy-grid-scroll">
            <table className="copy-grid">
              <thead>
                <tr>
                  <th className="copy-corner" />
                  {Array.from({ length: preview.width }, (_, c) => (
                    <th key={c}>{colToLetter(targetOrigin.col + c)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {Array.from({ length: preview.height }, (_, r) => (
                  <tr key={r}>
                    <td className="copy-rowhead">{targetOrigin.row + r + 1}</td>
                    {Array.from({ length: preview.width }, (_, c) => {
                  const cell = preview.cells[r * preview.width + c];
                  const st = preview.states.get(cell.target);
                  return (
                    <td
                      key={c}
                      className={
                        st?.error
                          ? st.error.type === 'cycle'
                            ? 'copy-cell copy-cell-cycle'
                            : st.error.source === st.key
                              ? 'copy-cell copy-cell-err'
                              : 'copy-cell copy-cell-down'
                          : 'copy-cell'
                      }
                      title={cell.targetRaw || '（清空）'}
                    >
                      <div className="copy-addr">{cell.target}</div>
                      <div className="copy-raw">
                        {cell.targetRaw
                          ? cell.parseError
                            ? `${cell.targetRaw}（#ERR! 原文照搬）`
                            : cell.targetRaw
                          : '（清空）'}
                      </div>
                      <div className="copy-out">
                        <OutcomeView
                          o={{
                            key: cell.target,
                            kind: st?.kind ?? null,
                            value: st?.value ?? null,
                            error: st?.error ?? null,
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

          <div className="copy-diff-head">
            最终候选依赖图：新增 / 消失的环、除零与传播变化（共{' '}
            {preview.changes.length} 格）
          </div>
          {summary && (summary.appeared.length > 0 || summary.gone.length > 0) && (
            <div className="copy-graph-summary">
              {summary.appeared.length > 0 && (
                <span className="copy-graph-new">
                  新增错误：{summary.appeared.join('、')}
                </span>
              )}
              {summary.gone.length > 0 && (
                <span className="copy-graph-gone">
                  消失错误：{summary.gone.join('、')}
                </span>
              )}
            </div>
          )}
          {preview.changes.length === 0 ? (
            <div className="hyp-nochange">复制不会改变任何格的精确值、错误或来源路径。</div>
          ) : (
            <table className="hyp-diff-table">
              <thead>
                <tr>
                  <th>格</th>
                  <th>复制前</th>
                  <th>复制后</th>
                  <th>错误来源 / 环路径</th>
                </tr>
              </thead>
              <tbody>
                {preview.changes.map((c) => (
                  <tr
                    key={c.key}
                    className={c.after.error ? `hyp-row-${c.after.error.type}` : ''}
                    onClick={() => onJump(c.key)}
                    title={`跳转到 ${c.key}`}
                  >
                    <td className="hyp-cell-key">{c.key}</td>
                    <td className="hyp-cell-out">
                      <OutcomeView o={c.before} />
                    </td>
                    <td className="hyp-cell-out">
                      <OutcomeView o={c.after} />
                    </td>
                    <td className="hyp-cell-path">
                      <PathView o={c.after} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
}
