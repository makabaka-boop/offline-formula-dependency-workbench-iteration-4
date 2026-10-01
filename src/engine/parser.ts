import { normalizeRef, type Addr } from './cells';

/* ------------------------------- AST ------------------------------- */

export type Expr =
  | { kind: 'int'; value: bigint }
  | { kind: 'ref'; addr: Addr; absCol: boolean; absRow: boolean }
  | { kind: 'unary'; op: '-'; operand: Expr }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr };

/* ----------------------------- 词法单元 ----------------------------- */

type TokenType = 'int' | 'ref' | 'op' | 'lparen' | 'rparen';
interface Token {
  type: TokenType;
  text: string;
  pos: number;
  /** 引用的锚定方式（仅 ref） */
  absCol?: boolean;
  absRow?: boolean;
}

/* ------------------------------ 错误 ------------------------------ */

export class ParseError extends Error {
  /** 0 起的字符位置（面向用户时 +1） */
  readonly pos: number;
  constructor(message: string, pos: number) {
    super(message);
    this.name = 'ParseError';
    this.pos = pos;
  }
}

/* ----------------------------- 词法分析 ----------------------------- */

function tokenize(input: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < input.length) {
    const c = input[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      i++;
      continue;
    }
    if (c >= '0' && c <= '9') {
      const start = i;
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      tokens.push({ type: 'int', text: input.slice(start, i), pos: start });
      continue;
    }
    // 引用：可选 “$” 列锚 + 列字母 + 可选 “$” 行锚 + 行号（$A1 / A$1 / $A$1 / A1）
    if (c === '$' || (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')) {
      const start = i;
      let absCol = false;
      if (input[i] === '$') {
        absCol = true;
        i++;
      }
      const letter = input[i];
      if (!letter || !/[A-Ta-t]/.test(letter)) {
        if (absCol) {
          throw new ParseError(
            '“$” 是列锚标记，其后必须紧跟 A..T 的列字母（如 $A1）',
            start,
          );
        }
        // 列字母越界（如 U1）：落入下面的统一标识符扫描，给出与旧词法一致的错误
        i++;
      } else {
        i++;
      }
      let absRow = false;
      if (input[i] === '$') {
        absRow = true;
        i++;
      }
      const digitsStart = i;
      while (i < input.length && input[i] >= '0' && input[i] <= '9') i++;
      const digits = input.slice(digitsStart, i);
      const text = letter + digits;
      if (digits === '' || !normalizeRef(text)) {
        // 锚定写法不合法（缺行号 / 行锚后不是数字 / 行列越界）：
        // 吞掉随后的字母数字与 $，给出与旧词法一致的错误分类
        let j = start + 1;
        while (
          j < input.length &&
          (/[A-Za-z0-9]/.test(input[j]) || input[j] === '$')
        ) {
          j++;
        }
        const word = input
          .slice(start, j)
          .replace(/\$/g, '');
        throw new ParseError(
          /^[A-Ta-t]/.test(word)
            ? `引用 ${word.toUpperCase()} 超出 A1..T20 范围（或锚定写法有误，行号须为 1..20）`
            : `不允许的名称或函数 “${word}”（仅支持 A1..T20 引用，不支持函数）`,
          start,
        );
      }
      tokens.push({
        type: 'ref',
        text: normalizeRef(text)!,
        pos: start,
        absCol,
        absRow,
      });
      continue;
    }
    if (c === '+' || c === '-' || c === '*' || c === '/') {
      tokens.push({ type: 'op', text: c, pos: i });
      i++;
      continue;
    }
    if (c === '(') {
      tokens.push({ type: 'lparen', text: c, pos: i });
      i++;
      continue;
    }
    if (c === ')') {
      tokens.push({ type: 'rparen', text: c, pos: i });
      i++;
      continue;
    }
    if (c === '.') {
      throw new ParseError('只允许整数，不允许小数', i);
    }
    throw new ParseError(`非法字符 “${c}”`, i);
  }
  return tokens;
}

/* --------------------------- 递归下降解析 --------------------------- */
/*
 * 文法（一元负号优先级高于乘除）：
 *   expr   := term (('+'|'-') term)*
 *   term   := factor (('*'|'/') factor)*
 *   factor := '-' factor | atom
 *   atom   := INT | REF | '(' expr ')'
 */

class Parser {
  private pos = 0;
  constructor(private readonly tokens: Token[]) {}

  parse(): Expr {
    const e = this.expr();
    if (this.pos < this.tokens.length) {
      const t = this.tokens[this.pos];
      throw new ParseError(
        t.type === 'rparen' ? '括号不匹配：多余的 “)”' : `表达式后存在多余内容 “${t.text}”`,
        t.pos,
      );
    }
    return e;
  }

  private peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  private expr(): Expr {
    let left = this.term();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.text === '+' || t.text === '-')) {
        this.pos++;
        const right = this.term();
        left = { kind: 'binary', op: t.text as '+' | '-', left, right };
      } else {
        return left;
      }
    }
  }

  private term(): Expr {
    let left = this.factor();
    for (;;) {
      const t = this.peek();
      if (t && t.type === 'op' && (t.text === '*' || t.text === '/')) {
        this.pos++;
        const right = this.factor();
        left = { kind: 'binary', op: t.text as '*' | '/', left, right };
      } else {
        return left;
      }
    }
  }

  private factor(): Expr {
    const t = this.peek();
    if (!t) throw new ParseError('公式不完整：此处应有数字或引用', 0);
    if (t.type === 'op' && t.text === '-') {
      this.pos++;
      return { kind: 'unary', op: '-', operand: this.factor() };
    }
    if (t.type === 'op' && t.text === '+') {
      throw new ParseError('不支持一元正号 “+”，数字直接书写即可', t.pos);
    }
    if (t.type === 'op') {
      throw new ParseError(`运算符 “${t.text}” 前缺少操作数`, t.pos);
    }
    return this.atom();
  }

  private atom(): Expr {
    const t = this.peek();
    if (!t) throw new ParseError('公式不完整：此处应有数字或引用', 0);
    if (t.type === 'int') {
      this.pos++;
      return { kind: 'int', value: BigInt(t.text) };
    }
    if (t.type === 'ref') {
      this.pos++;
      return {
        kind: 'ref',
        addr: t.text as Addr,
        absCol: t.absCol ?? false,
        absRow: t.absRow ?? false,
      };
    }
    if (t.type === 'lparen') {
      this.pos++;
      const inner = this.expr();
      const close = this.peek();
      if (!close || close.type !== 'rparen') {
        throw new ParseError('括号不匹配：缺少 “)”', t.pos);
      }
      this.pos++;
      return inner;
    }
    if (t.type === 'rparen') {
      throw new ParseError('括号不匹配：多余的 “)”', t.pos);
    }
    throw new ParseError(`此处不应出现 “${t.text}”`, t.pos);
  }
}

/* ------------------------------ 单元格输入 ------------------------------ */

export type ParsedCell =
  | { kind: 'empty' }
  | { kind: 'number'; value: bigint; expr: Expr }
  | { kind: 'formula'; expr: Expr };

/**
 * 解析一格的原始输入文本。
 * 空（或纯空白）=> empty；“=” 开头 => 公式；否则必须是整数（可带一元负号）。
 */
export function parseCellInput(raw: string): ParsedCell {
  if (raw.trim() === '') return { kind: 'empty' };
  if (raw.startsWith('=')) {
    const body = raw.slice(1);
    if (body.trim() === '') {
      throw new ParseError('“=” 后缺少表达式', 1);
    }
    return { kind: 'formula', expr: parseExpr(body) };
  }
  if (!/^\s*-?\d+\s*$/.test(raw)) {
    throw new ParseError('单元格必须为空、整数或以 = 开头的公式', 0);
  }
  const value = BigInt(raw.trim());
  return { kind: 'number', value, expr: { kind: 'int', value } };
}

/** 解析 “=” 之后的表达式 */
export function parseExpr(body: string): Expr {
  const tokens = tokenize(body);
  if (tokens.length === 0) {
    throw new ParseError('公式为空', 0);
  }
  return new Parser(tokens).parse();
}

/** 收集表达式中的直接引用（去重、保持出现顺序） */
export function collectRefs(expr: Expr): Addr[] {
  const out: Addr[] = [];
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case 'int':
        return;
      case 'ref':
        if (!out.includes(e.addr)) out.push(e.addr);
        return;
      case 'unary':
        walk(e.operand);
        return;
      case 'binary':
        walk(e.left);
        walk(e.right);
        return;
    }
  };
  walk(expr);
  return out;
}

/* --------------------------- 复制时的引用转换 --------------------------- */

/**
 * 匹配公式体内的一个引用 token：($?)(列字母)($?)(行数字)。
 * 行号分支 20 在 2 之前，并以 (?!\\d) 收尾，避免把 A20 截成 A2+0。
 */
const REF_TOKEN_RE = /(\$?)([A-Ta-t])(\$?)(20|1[0-9]|0?[1-9])(?!\d)/g;

export interface TranslateResult {
  ok: boolean;
  /** 转换后的原文（ok 时有效；解析失败的源格原样返回） */
  text: string;
  /** 转换后越界的引用（含锚定写法），命中即由调用方整组拒绝 */
  outOfRange: string[];
}

/**
 * 把一格原始输入从源格复制到目标格时转换其中的引用。
 *
 * - 空 / 整数：原样返回。
 * - 公式：相对行列按“源格 → 目标格”的偏移平移；$ 锚定的列或行保持不动。
 *   输入本身必须先通过解析器（调用方对 #ERR! 源格走“复制原文”分支，不调用本函数）。
 * - 任一转换后引用越出 A..T / 1..20：在 outOfRange 中列出，调用方须整组拒绝。
 */
export function translateCellInput(
  raw: string,
  dc: number,
  dr: number,
): TranslateResult {
  if (raw.trim() === '' || !raw.startsWith('=')) {
    return { ok: true, text: raw, outOfRange: [] };
  }
  const outOfRange: string[] = [];
  const body = raw.slice(1);
  const next = body.replace(
    REF_TOKEN_RE,
    (token, colMark: string, letter: string, rowMark: string, digits: string) => {
      const colAbs = colMark === '$';
      const rowAbs = rowMark === '$';
      const col0 = letter.toUpperCase().charCodeAt(0) - 65;
      const row0 = parseInt(digits, 10) - 1;
      const nc = colAbs ? col0 : col0 + dc;
      const nr = rowAbs ? row0 : row0 + dr;
      if (nc < 0 || nc >= 20 || nr < 0 || nr >= 20) {
        outOfRange.push(token.toUpperCase());
        return token;
      }
      const L = String.fromCharCode(65 + nc);
      const n = nr + 1;
      return `${colMark}${L}${rowMark}${n}`;
    },
  );
  return { ok: outOfRange.length === 0, text: '=' + next, outOfRange };
}
