export const T = {
  GET:         'GET',
  WHERE:       'WHERE',
  AND:         'AND',
  KEY_PATTERN: 'KEY_PATTERN',
  IDENT:       'IDENT',
  STRING:      'STRING',
  NUMBER:      'NUMBER',
  BOOL:        'BOOL',
  EQ:          '=',
  NEQ:         '!=',
  GT:          '>',
  LT:          '<',
  GTE:         '>=',
  LTE:         '<=',
  EOF:         'EOF',
};

export function tokenize(input) {
  if (typeof input !== 'string') throw new TypeError('tokenize: input must be a string');

  const tokens = [];
  let i = 0;

  function skipWhitespace() {
    while (i < input.length && /\s/.test(input[i])) i++;
  }

  while (i < input.length) {
    skipWhitespace();
    if (i >= input.length) break;

    if (input[i] === '"' || input[i] === "'") {
      const quote = input[i++];
      let str = '';
      while (i < input.length && input[i] !== quote) {
        if (input[i] === '\\') i++;
        str += input[i++];
      }
      if (i >= input.length) throw new Error('Unterminated string literal');
      i++;
      tokens.push({ type: T.STRING, value: str });
      continue;
    }

    if (/[0-9]/.test(input[i]) || (input[i] === '-' && /[0-9]/.test(input[i + 1]))) {
      let num = '';
      if (input[i] === '-') num += input[i++];
      while (i < input.length && /[0-9.]/.test(input[i])) num += input[i++];
      tokens.push({ type: T.NUMBER, value: Number(num) });
      continue;
    }

    if (input[i] === '!' && input[i + 1] === '=') { tokens.push({ type: T.NEQ }); i += 2; continue; }
    if (input[i] === '>' && input[i + 1] === '=') { tokens.push({ type: T.GTE }); i += 2; continue; }
    if (input[i] === '<' && input[i + 1] === '=') { tokens.push({ type: T.LTE }); i += 2; continue; }

    if (input[i] === '=') { tokens.push({ type: T.EQ });  i++; continue; }
    if (input[i] === '>') { tokens.push({ type: T.GT });  i++; continue; }
    if (input[i] === '<') { tokens.push({ type: T.LT });  i++; continue; }

    if (/[a-zA-Z_]/.test(input[i])) {
      let word = '';
      while (i < input.length && /[a-zA-Z0-9_]/.test(input[i])) word += input[i++];

      const upper = word.toUpperCase();

      if (upper === 'GET') {
        tokens.push({ type: T.GET });
        skipWhitespace();
        let pattern = '';
        while (i < input.length && !/\s/.test(input[i])) pattern += input[i++];
        if (!pattern) throw new Error('GET requires a key pattern (e.g. *, user:*, user:alice)');
        tokens.push({ type: T.KEY_PATTERN, value: pattern });
        continue;
      }

      if (upper === 'WHERE') { tokens.push({ type: T.WHERE }); continue; }
      if (upper === 'AND')   { tokens.push({ type: T.AND });   continue; }
      if (word === 'true')   { tokens.push({ type: T.BOOL, value: true });  continue; }
      if (word === 'false')  { tokens.push({ type: T.BOOL, value: false }); continue; }

      tokens.push({ type: T.IDENT, value: word });
      continue;
    }

    throw new Error(`Unexpected character "${input[i]}" at position ${i}`);
  }

  tokens.push({ type: T.EOF });
  return tokens;
}
