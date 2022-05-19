import { parse, eval as expEval } from "expression-eval";

export interface VariableResolver {
  getMemory(address: number): Promise<number>;
  getVariables(frameIndex?: number): Promise<Record<string, number>>;
}

export async function evaluateExpression(
  expression: string,
  frameIndex: number | undefined,
  resolver: VariableResolver
): Promise<number> {
  // Convert all numbers to decimal:
  let exp = expression
    // Hex
    .replace(/(\$|0x)([0-9a-f]+)/gi, (_, _2, d) => parseInt(d, 16).toString())
    // Octal
    .replace(/(@|0o)([0-7]+)/gi, (_, _2, d) => parseInt(d, 8).toString())
    // Binary
    .replace(/(%|0b)([0-1]+)/gi, (_, _2, d) => parseInt(d, 2).toString());

  // Return value if numeric
  if (exp.match(/^[0-9]+$/i)) {
    return parseInt(exp, 10);
  }

  const variables = await resolver.getVariables(frameIndex);

  // Replace all variables
  const matches = expression.matchAll(/([$#])\{([^}]+)\}/gi);
  for (const [fullStr, prefix, variableName] of matches) {
    let value = variables[variableName];
    if (value) {
      if (prefix === "#") {
        value = await resolver.getMemory(value);
      }
      exp = exp.replace(fullStr, value.toString());
    }
  }

  // Evaluate expression
  const result = expEval(parse(exp), variables);
  if (isNaN(result)) {
    throw new Error("Unable to evaluate expression: " + exp);
  }
  return Math.round(result);
}
