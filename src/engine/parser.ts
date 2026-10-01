import { COLS, ROWS, normalizeRef, type Addr } from './cells';

/* ------------------------------- AST ------------------------------- */

export type Expr =
  | { kind: 'int'; value: bigint }
  | { kind: 'ref'; addr: Addr }
  | { kind: 'unary'; op: '-'; operand: Expr }
  | { kind: 'binary'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr };

/* ----------------------------- 词法单元 ----------------------------- */

type TokenType = 'int' | 'ref' | 'op' | 'lparen' | 'rparen';
interface Token {
  type: TokenType;
  text: string;
  pos: number;
  /** 仅引用：$ 锚定（列/行被锁） */
  colAnchored?: boolean;
  rowAnchored?: boolean;
  /** 仅引用：token 结束位置（不含），$ 时与正文长度不同 */
  end?: number;
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

/**
 * 从 start 处读取一个（可能带 $ 锚定的）引用，支持四种写法：
 * A1（相对）、$A1（锁列）、A$1（锁行）、$A$1（全锁）。
 * 入参要求 s[start] 是字母或 '$'。校验失败抛 ParseError。
 */
function scanRef(input: string, start: number): Token {
  let i = start;
  let colAnchored = false;
  if (input[i] === '$') {
    colAnchored = true;
    i++;
  }
  const colLetter = input[i];
  if (!colLetter || !/[A-Za-z]/.test(colLetter)) {
    throw new ParseError('“$” 后必须是列字母（A..T），如 $A1', start);
  }
  i++;
  let rowAnchored = false;
  if (input[i] === '$') {
    rowAnchored = true;
    i++;
  }
  const digitsStart = i;
  while (input[i] >= '0' && input[i] <= '9') i++;
  // 字母/数字相邻：要么是函数名（SUM），要么是缺运算符的粘连（A1B2）
  if (/[A-Za-z]/.test(input[i] ?? '')) {
    let j = i;
    while (/[A-Za-z0-9$]/.test(input[j] ?? '')) j++;
    const name = input.slice(start, j);
    throw new ParseError(
      `不允许的名称或函数 “${name.toUpperCase()}”（仅支持 A1..T20 引用，不支持函数）`,
      start,
    );
  }
  const body = colLetter + input.slice(digitsStart, i);
  const addr = normalizeRef(body);
  if (!addr) {
    // 列超范围与行超范围给不同提示，方便质检员定位 $ 写法问题
    const code = colLetter.toUpperCase().charCodeAt(0) - 65;
    if (code < 0 || code >= COLS) {
      throw new ParseError(
        `引用 ${colLetter.toUpperCase()} 列超出 A1..T20 范围（列仅 A..T）`,
        start,
      );
    }
    const digits = input.slice(digitsStart, i);
    throw new ParseError(
      digits === ''
        ? `引用 ${colLetter.toUpperCase()} 缺少行号，合法范围 A1..T${ROWS}`
        : `引用 ${colLetter.toUpperCase()}${parseInt(digits, 10)} 超出 A1..T${ROWS} 范围`,
      start,
    );
  }
  return {
    type: 'ref',
    text: addr,
    pos: start,
    end: i,
    colAnchored,
    rowAnchored,
  };
}

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
    if ((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c === '$') {
      const tok = scanRef(input, i);
      i = tok.end!;
      tokens.push(tok);
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
      return { kind: 'ref', addr: t.text as Addr };
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

/** 表达式原文中的一个引用片段（含 $ 锚定信息），用于矩形复制时平移重写 */
export interface RefSpan {
  /** 引用规范化地址（不含 $） */
  addr: Addr;
  /** 0 起的列、行索引 */
  col: number;
  row: number;
  colAnchored: boolean;
  rowAnchored: boolean;
  /** 在公式正文（“=” 之后的部分）中的起止位置 */
  start: number;
  end: number;
}

/**
 * 词法扫描公式正文，按出现顺序给出全部引用片段。
 * 与完整解析共享同一个词法分析器：正文含语法错误时同样抛 ParseError。
 */
export function refSpans(body: string): RefSpan[] {
  const spans: RefSpan[] = [];
  for (const t of tokenize(body)) {
    if (t.type !== 'ref') continue;
    const m = /^([A-T])([1-9]|1[0-9]|20)$/.exec(t.text)!;
    spans.push({
      addr: t.text as Addr,
      col: m[1].charCodeAt(0) - 65,
      row: parseInt(m[2], 10) - 1,
      colAnchored: !!t.colAnchored,
      rowAnchored: !!t.rowAnchored,
      start: t.pos,
      end: t.end!,
    });
  }
  return spans;
}
