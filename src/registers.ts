export interface Register {
  name: string;
  value: number;
}

export const REGISTER_D0_INDEX = 0; // -> 0 to 7
export const REGISTER_A0_INDEX = 8; // -> 8 to 15
export const REGISTER_SR_INDEX = 16;
export const REGISTER_PC_INDEX = 17;

const SR_LABELS = [
  "T1",
  "T0",
  "S",
  "M",
  null,
  "I",
  "I",
  "I",
  null,
  null,
  null,
  "X",
  "N",
  "Z",
  "V",
  "C",
];

export function nameRegisters(registerValues: number[]): Register[] {
  const registers: Register[] = [];
  registers.push({
    name: "pc",
    value: registerValues[REGISTER_PC_INDEX],
  });
  for (let i = 0; i < 8; i++) {
    registers.push({
      name: "d" + i,
      value: registerValues[i + REGISTER_D0_INDEX],
    });
  }
  for (let i = 0; i < 8; i++) {
    registers.push({
      name: "a" + i,
      value: registerValues[i + REGISTER_A0_INDEX],
    });
  }
  registers.push({
    name: "sr",
    value: registerValues[REGISTER_SR_INDEX],
  });
  return registers.concat(
    getSRDetailedValues(registerValues[REGISTER_SR_INDEX])
  );
}

export function getRegisterIndex(name: string): number {
  if (name.length > 1) {
    const type = name.charAt(0);
    const idx = parseInt(name.charAt(1));
    if (type === "d") {
      return idx + REGISTER_D0_INDEX;
    } else if (type === "a") {
      return idx + REGISTER_A0_INDEX;
    } else if (name === "pc") {
      return REGISTER_PC_INDEX;
    } else if (name === "sr") {
      return REGISTER_SR_INDEX;
    }
  }
  throw new Error("Invalid register name: " + name);
}

export function getSRDetailedValues(srValue: number): Register[] {
  const registers: Register[] = [];
  let intMask = 0;
  let intPos = 2;
  for (let i = 0; i < SR_LABELS.length; i++) {
    const label = SR_LABELS[i];
    if (label !== null) {
      const mask = 1 << (15 - i);
      const b = srValue & mask;
      let vb = 0;
      if (b) {
        vb = 1;
      }
      if (label.startsWith("I")) {
        intMask = intMask | (vb << intPos);
        intPos--;
        if (intPos < 0) {
          registers.push({
            name: "SR_intmask",
            value: intMask,
          });
        }
      } else {
        registers.push({
          name: `SR_${label}`,
          value: vb,
        });
      }
    }
  }
  return registers;
}
