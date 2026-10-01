// @vitest-environment jsdom
import '../test/setup-dom';
import { describe, expect, it, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from './App';
import { lastExport, resetExport } from '../test/setup';

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

function panel(): HTMLElement {
  return document.querySelector('.copy-panel') as HTMLElement;
}

function sourceInput(): HTMLInputElement {
  const labels = panel().querySelectorAll('input.hyp-addr-input');
  return labels[0] as HTMLInputElement;
}
function topLeftInput(): HTMLInputElement {
  const labels = panel().querySelectorAll('input.hyp-addr-input');
  return labels[1] as HTMLInputElement;
}
function sizeInputs(): HTMLInputElement[] {
  return [...panel().querySelectorAll('input.copy-size-input')] as HTMLInputElement[];
}

/** 在矩形复制面板里填表并生成预览 */
async function fillForm(
  user: ReturnType<typeof userEvent.setup>,
  source: string,
  topLeft: string,
  w: number,
  h: number,
): Promise<void> {
  const [wIn, hIn] = sizeInputs();
  await user.clear(sourceInput());
  await user.type(sourceInput(), source);
  await user.clear(topLeftInput());
  await user.type(topLeftInput(), topLeft);
  await user.clear(wIn);
  await user.type(wIn, String(w));
  await user.clear(hIn);
  await user.type(hIn, String(h));
  await user.click(screen.getByRole('button', { name: '生成复制预览' }));
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

describe('矩形复制页面工作流：过期预览不能覆盖后续编辑', () => {
  beforeEach(() => {
    resetExport();
  });

  it('生成预览后编辑网格：确认按钮禁用、过期提示出现、确认绝不写入后续编辑', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    expect(revisionOf(container)).toBe(1);
    // 演示中 A1=8, A2=3, B1==A1+A2*2=14
    expect(cellDiv(container, 'B1').textContent).toBe('14');

    // —— 基于 r1 生成复制预览：源 A1 -> E1（1×1，常量复制；E1 在演示中为空）——
    await user.click(screen.getByRole('button', { name: '矩形复制' }));
    await fillForm(user, 'A1', 'E1', 1, 1);
    const confirmBtn = screen.getByRole('button', { name: '确认写入矩形' });
    expect(confirmBtn).not.toBeDisabled();
    expect(panel().querySelector('.hyp-stale')).toBeNull();
    // 预览矩形显示 E1 将写入 8
    expect(panel().textContent).toContain('8');

    // —— 预览打开期间在正式网格做后续编辑：A1 8 -> 40（真实修订 r2）——
    await editCell(user, container, 'A1', '40');
    expect(revisionOf(container)).toBe(2);
    expect(cellDiv(container, 'A1').textContent).toBe('40');
    expect(cellDiv(container, 'B1').textContent).toBe('46');

    // 过期：按钮禁用、出现过期横幅；确认按钮即便被调用也不写入
    expect(confirmBtn).toBeDisabled();
    expect(panel().querySelector('.hyp-stale')).not.toBeNull();
    expect(panel().querySelector('.hyp-stale')!.textContent).toContain('r1');
    // E1 没有被旧预览写入
    expect(cellDiv(container, 'E1').textContent).toBe('');

    // 旧预览期间导出：不含 E1 的 8，修订号为 r2
    await user.click(screen.getByRole('button', { name: '导出 JSON 快照' }));
    const exported = JSON.parse(lastExport()) as {
      revision: number;
      cells: { addr: string; raw: string }[];
    };
    expect(exported.revision).toBe(2);
    expect(exported.cells.find((c) => c.addr === 'A1')!.raw).toBe('40');
    expect(exported.cells.find((c) => c.addr === 'E1')).toBeUndefined();
  }, 60_000);

  it('重新生成预览（依据新修订）后可以确认，且只产生一次写入', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '载入演示' }));
    await user.click(screen.getByRole('button', { name: '矩形复制' }));

    // 基于 r1 的过期预览
    await fillForm(user, 'A1', 'E1', 1, 1);
    await editCell(user, container, 'A1', '40');
    expect(revisionOf(container)).toBe(2);
    expect(screen.getByRole('button', { name: '确认写入矩形' })).toBeDisabled();

    // 重新生成：依据 r2，源 A1 现为 40，确认写入 E1=40
    await user.click(screen.getByRole('button', { name: '生成复制预览' }));
    const confirmBtn = screen.getByRole('button', { name: '确认写入矩形' });
    expect(confirmBtn).not.toBeDisabled();
    expect(panel().querySelector('.hyp-stale')).toBeNull();
    await user.click(confirmBtn);
    expect(revisionOf(container)).toBe(3); // r2 -> r3，只 +1
    expect(cellDiv(container, 'E1').textContent).toBe('40');
    // 确认后面板关闭
    expect(document.querySelector('.copy-panel')).toBeNull();
  }, 60_000);

  it('5×5 以上的矩形被拒绝：显示原因且网格、修订号不变', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    await user.click(screen.getByRole('button', { name: '矩形复制' }));
    await fillForm(user, 'A1', 'B1', 6, 5);
    expect(panel().querySelector('.hyp-reject')!.textContent).toContain('5×5');
    expect(screen.queryByRole('button', { name: '确认写入矩形' })).toBeNull();
    expect(revisionOf(container)).toBe(0);
  }, 30_000);

  it('引用平移后越界整组拒绝：给出越界目标与引用，网格不变', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    // 源 B1 引用 A1；左移一格到 A1 会让引用越出 A 列
    await editCell(user, container, 'B1', '=A1+1');
    expect(revisionOf(container)).toBe(1);
    await user.click(screen.getByRole('button', { name: '矩形复制' }));
    await fillForm(user, 'B1', 'A1', 1, 1);
    expect(panel().querySelector('.hyp-reject')!.textContent).toContain('A1');
    expect(panel().querySelector('.hyp-reject')!.textContent).toContain('越界');
    expect(revisionOf(container)).toBe(1);
    expect(cellDiv(container, 'A1').textContent).toBe('');
  }, 30_000);

  it('重叠复制在页面上：相对引用按各目标偏移平移，确认后结果正确', async () => {
    const user = userEvent.setup({ delay: null });
    const { container } = render(<App />);
    // A1=10，源 C1=B1；横排复制到 B1..D1
    await editCell(user, container, 'A1', '10');
    await editCell(user, container, 'C1', '=B1');
    await user.click(screen.getByRole('button', { name: '矩形复制' }));
    await fillForm(user, 'C1', 'B1', 3, 1);

    // 矩形预览逐格展示平移后的原文
    const rect = panel().querySelector('table.copy-rect')!;
    const cells = [...rect.querySelectorAll('.copy-cell')];
    expect(cells.map((c) => c.querySelector('.copy-cell-raw')!.textContent)).toEqual([
      '=A1',
      '=B1',
      '=C1',
    ]);
    // 源格高亮且标记在中间
    expect(cells[1].className).toContain('copy-cell-source');

    await user.click(screen.getByRole('button', { name: '确认写入矩形' }));
    expect(cellDiv(container, 'B1').textContent).toBe('10');
    expect(cellDiv(container, 'C1').textContent).toBe('10');
    expect(cellDiv(container, 'D1').textContent).toBe('10');
  }, 60_000);
});
