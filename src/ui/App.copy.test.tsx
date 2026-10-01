// @vitest-environment jsdom
import '../test/setup-dom';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { resetExport } from '../test/setup';

/** 解析 A1..T20 风格地址为网格 td 元素 */
function cellEl(container: HTMLElement, addr: string): HTMLElement {
  const m = /^([A-T])(\d{1,2})$/.exec(addr)!;
  const col = m[1].charCodeAt(0) - 65;
  const row = Number(m[2]) - 1;
  const tbody = container.querySelector('table.sheet tbody')!;
  const tr = tbody.querySelectorAll('tr')[row];
  return tr.querySelectorAll('td')[col + 1] as HTMLElement;
}

function cellDiv(container: HTMLElement, addr: string): HTMLElement {
  const el = cellEl(container, addr);
  return (el.querySelector('.cell') as HTMLElement) ?? el;
}

function revisionOf(container: HTMLElement): number {
  const m = /快照修订 r(\d+)/.exec(container.textContent ?? '')!;
  return Number(m[1]);
}

/** 双击网格编辑某格并以 Enter 确认 */
async function editCell(
  user: ReturnType<typeof userEvent.setup>,
  container: HTMLElement,
  addr: string,
  text: string,
): Promise<void> {
  await user.dblClick(cellDiv(container, addr));
  const editor = cellEl(container, addr).querySelector(
    'input.cell-input',
  ) as HTMLInputElement;
  await user.clear(editor);
  await user.type(editor, text);
  await user.keyboard('{Enter}');
}

async function openCopy(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(screen.getByRole('button', { name: '矩形复制' }));
}

/** 填写复制表单并点击预演 */
async function fillAndPreview(
  user: ReturnType<typeof userEvent.setup>,
  s: string,
  d: string,
  w = '1',
  h = '1',
): Promise<void> {
  const src = document.querySelector('.copy-input[placeholder="A1"]') as HTMLInputElement;
  const dst = document.querySelector('.copy-input[placeholder="C3"]') as HTMLInputElement;
  const dims = document.querySelectorAll(
    '.copy-dim-input',
  ) as NodeListOf<HTMLInputElement>;
  await user.clear(src);
  await user.type(src, s);
  await user.clear(dst);
  await user.type(dst, d);
  await user.clear(dims[0]);
  await user.type(dims[0], w);
  await user.clear(dims[1]);
  await user.type(dims[1], h);
  await user.click(screen.getByRole('button', { name: '预演复制' }));
}

describe('矩形复制页面工作流', () => {
  beforeEach(() => {
    resetExport();
  });

  it('四种锚定在矩形预览中按偏移转换，确认一次写入并递增一个修订', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    // 干净网格：A1=8，B2 放四锚定混合公式
    await editCell(user, container, 'A1', '8');
    await editCell(user, container, 'B2', '=A1+$A1+A$1+$A$1');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'B2').textContent).toBe('32');

    await openCopy(user);
    // B2 -> D4：dc=2, dr=2
    await fillAndPreview(user, 'B2', 'D4');

    // 预览格 D4 展示转换后原文
    const previewCell = document.querySelector('.copy-grid .copy-cell') as HTMLElement;
    expect(previewCell.querySelector('.copy-raw')!.textContent).toBe(
      '=C3+$A3+C$1+$A$1',
    );
    // 最终候选图：C3 空=0、$A3 空=0、C$1 空=0、$A$1=8 => 8
    expect(previewCell.querySelector('.copy-out')!.textContent).toBe('8');

    await user.click(screen.getByRole('button', { name: /确认写入全部/ }));
    expect(revisionOf(container)).toBe(3); // 仅 +1
    expect(cellDiv(container, 'D4').textContent).toBe('8');
  }, 60_000);

  it('过期预览不能覆盖后续编辑：预演后改动正式网格，确认禁用且数据不回滚', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    // 干净网格：A1=8，B1=A1+1；C1 保持空白便于断言“预演从未写入”
    await editCell(user, container, 'A1', '8');
    await editCell(user, container, 'B1', '=A1+1');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'C1').textContent).toBe('');

    // 基于 r2 预演：把 A1=8 复制到 C1
    await openCopy(user);
    await fillAndPreview(user, 'A1', 'C1');
    const adopt = screen.getByRole('button', { name: /确认写入全部/ });
    expect(adopt).not.toBeDisabled();
    expect(document.querySelector('.hyp-stale')).toBeNull();
    // 预览表格显示 C1 <- 8
    const previewCell = document.querySelector('.copy-grid .copy-cell') as HTMLElement;
    expect(previewCell.querySelector('.copy-raw')!.textContent).toBe('8');

    // 不确认，直接在正式网格上把 A1 改为 40（真实修订 r3）
    await editCell(user, container, 'A1', '40');
    expect(revisionOf(container)).toBe(3);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    expect(cellDiv(container, 'C1').textContent).toBe(''); // 预演从未写入

    // 旧预演过期：确认按钮禁用、出现过期提示
    expect(adopt).toBeDisabled();
    const stale = document.querySelector('.hyp-stale') as HTMLElement;
    expect(stale).not.toBeNull();
    expect(stale.textContent).toContain('r2');
    expect(stale.textContent).toContain('r3');

    // 尝试点击禁用按钮：无效，后续编辑不被覆盖
    await user.click(adopt);
    expect(revisionOf(container)).toBe(3);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    expect(cellDiv(container, 'C1').textContent).toBe('');
    // 下游保留后续编辑的结果：B1 = 41
    expect(cellDiv(container, 'B1').textContent).toBe('41');

    // 重新基于 r3 预演：过期提示消失，可以正常确认写入
    await fillAndPreview(user, 'A1', 'C1');
    const adopt2 = screen.getByRole('button', { name: /确认写入全部/ });
    expect(adopt2).not.toBeDisabled();
    expect(document.querySelector('.hyp-stale')).toBeNull();
    await user.click(adopt2);
    expect(revisionOf(container)).toBe(4);
    expect(cellDiv(container, 'C1').textContent).toBe('40');
  }, 60_000);

  it('越界复制整组拒绝：红条列出原因，网格与修订号不变', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));

    await openCopy(user);
    // B1=A1+A2*2 左移到 A1：A1 转换后越出左边界
    await fillAndPreview(user, 'B1', 'A1');
    const reject = document.querySelector('.hyp-reject') as HTMLElement;
    expect(reject).not.toBeNull();
    expect(reject.textContent).toContain('超出');
    expect(screen.queryByRole('button', { name: /确认写入全部/ })).toBeNull();
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('8');
  }, 60_000);

  it('重叠复制：源快照先冻结，预览与写入都不被已写入目标格污染', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    // 构造 A1=1, B1=A1, C1=B1，再整体右移到 B1..D1
    await editCell(user, container, 'A1', '1');
    await editCell(user, container, 'B1', '=A1');
    await editCell(user, container, 'C1', '=B1');

    await openCopy(user);
    await fillAndPreview(user, 'A1', 'B1', '3', '1');
    const cells = document.querySelectorAll('.copy-grid .copy-cell');
    expect(cells).toHaveLength(3);
    expect(cells[0].querySelector('.copy-addr')!.textContent).toBe('B1');
    expect(cells[0].querySelector('.copy-raw')!.textContent).toBe('1');
    expect(cells[1].querySelector('.copy-addr')!.textContent).toBe('C1');
    expect(cells[1].querySelector('.copy-raw')!.textContent).toBe('=B1');
    expect(cells[2].querySelector('.copy-addr')!.textContent).toBe('D1');
    expect(cells[2].querySelector('.copy-raw')!.textContent).toBe('=C1');
    // 最终候选图：D1=C1=B1=1
    expect(cells[2].querySelector('.copy-out')!.textContent).toBe('1');

    await user.click(screen.getByRole('button', { name: /确认写入全部/ }));
    expect(cellDiv(container, 'B1').textContent).toBe('1');
    expect(cellDiv(container, 'C1').textContent).toBe('1');
    expect(cellDiv(container, 'D1').textContent).toBe('1');
    expect(cellDiv(container, 'A1').textContent).toBe('1');
  }, 90_000);

  it('#ERR! 源格原文照搬：目标格在最终图上同样标记解析错误', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await editCell(user, container, 'A1', '=1+');
    await openCopy(user);
    await fillAndPreview(user, 'A1', 'D5');
    const cell = document.querySelector('.copy-grid .copy-cell') as HTMLElement;
    expect(cell.querySelector('.copy-raw')!.textContent).toContain('=1+');
    expect(cell.querySelector('.copy-raw')!.textContent).toContain('原文照搬');
    expect(cell.querySelector('.copy-out')!.textContent).toBe('#ERR!');
    await user.click(screen.getByRole('button', { name: /确认写入全部/ }));
    expect(cellDiv(container, 'D5').textContent).toBe('#ERR!');
    // 源格保持 #ERR! 原文
    expect(cellDiv(container, 'A1').textContent).toBe('#ERR!');
  }, 60_000);
});
