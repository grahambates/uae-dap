import { parse, eval as expEval } from "expression-eval";

export interface VariableResolver {
  getVariableValue(variable: string, frameIndex?: number): Promise<string>;
  getVariablePointedMemory(
    variableName: string,
    frameIndex?: number,
    size?: number
  ): Promise<string>;
}

export async function evaluateExpression(
  expression: string,
  frameIndex: number | undefined,
  resolver: VariableResolver
): Promise<number> {
  if (!expression) {
    throw new Error("Invalid address");
  }

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

  // Replace all variables
  const matches = expression.matchAll(/([$#])\{([^}]+)\}/gi);
  for (const [fullStr, prefix, variableName] of matches) {
    const value = await (prefix === "$"
      ? resolver.getVariableValue(variableName, frameIndex)
      : resolver.getVariablePointedMemory(variableName, frameIndex));
    if (value) {
      exp = exp.replace(fullStr, parseInt(value).toString());
    }
  }

  // Evaluate expression
  const result = expEval(parse(exp), {});
  if (isNaN(result)) {
    throw new Error("Unable to evaluate expression: " + exp);
  }
  return Math.round(result);
}
