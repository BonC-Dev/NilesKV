import { T } from './lexer.js';

export function parse(tokens) {
  let pos = 0;

  function peek() { return tokens[pos]; }

  function consume(type) {
    const tok = tokens[pos];
    if (type && tok.type !== type) {
      const got = tok.value !== undefined ? `"${tok.value}" (${tok.type})` : tok.type;
      throw new Error(`Expected ${type} but got ${got}`);
    }
    pos++;
    return tok;
  }

  function parseQuery() {
    consume(T.GET);
    const pattern = parsePattern();
    let where = null;
    if (peek().type === T.WHERE) {
      consume(T.WHERE);
      where = parseCondition();
    }
    consume(T.EOF);
    return { type: 'Query', pattern, where };
  }

  function parsePattern() {
    const tok = consume(T.KEY_PATTERN);
    const val = tok.value;
    if (val === '*') return { type: 'WildcardPattern' };
    if (val.endsWith(':*')) return { type: 'PrefixPattern', prefix: val.slice(0, -2) };
    return { type: 'ExactPattern', key: val };
  }

  function parseCondition() {
    const first = parseComparison();
    if (peek().type !== T.AND) return first;
    const conditions = [first];
    while (peek().type === T.AND) {
      consume(T.AND);
      conditions.push(parseComparison());
    }
    return { type: 'And', conditions };
  }

  function parseComparison() {
    const field = consume(T.IDENT).value;
    const op    = parseOp();
    const value = parseLiteral();
    return { type: 'Comparison', field, op, value };
  }

  function parseOp() {
    const tok = tokens[pos++];
    if ([T.EQ, T.NEQ, T.GT, T.LT, T.GTE, T.LTE].includes(tok.type)) return tok.type;
    throw new Error(`Expected a comparison operator (=, !=, >, <, >=, <=) but got "${tok.type}"`);
  }

  function parseLiteral() {
    const tok = tokens[pos];
    if (tok.type === T.STRING || tok.type === T.NUMBER || tok.type === T.BOOL) {
      pos++;
      return tok.value;
    }
    throw new Error(`Expected a value (string, number, or true/false) but got "${tok.type}"`);
  }

  return parseQuery();
}
