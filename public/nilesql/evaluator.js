export function matchesPattern(key, pattern) {
  switch (pattern.type) {
    case 'WildcardPattern': return true;
    case 'PrefixPattern':   return key.startsWith(pattern.prefix + ':');
    case 'ExactPattern':    return key === pattern.key;
    default: return false;
  }
}

export function evaluate(ast, documents) {
  const results = [];
  for (const [key, doc] of Object.entries(documents)) {
    if (!matchesPattern(key, ast.pattern)) continue;
    if (ast.where !== null && !evalCondition(ast.where, doc)) continue;
    results.push({ key, doc });
  }
  return results;
}

function evalCondition(node, doc) {
  if (node.type === 'And') {
    return node.conditions.every(c => evalCondition(c, doc));
  }
  if (node.type === 'Comparison') {
    const val = doc[node.field];
    if (val === undefined || val === null) return false;
    return compare(val, node.op, node.value);
  }
  return false;
}

function compare(a, op, b) {
  switch (op) {
    case '=':  return a === b;
    case '!=': return a !== b;
    case '>':  return a > b;
    case '<':  return a < b;
    case '>=': return a >= b;
    case '<=': return a <= b;
    default:   return false;
  }
}
