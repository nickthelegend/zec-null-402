declare module 'circomlibjs' {
  export function buildPoseidon(): Promise<{
    (inputs: (bigint | number | string)[]): unknown;
    F: { toString(v: unknown): string };
  }>;
}
declare module 'snarkjs' {
  export const groth16: {
    fullProve(input: object, wasm: string, zkey: string): Promise<{ proof: object; publicSignals: string[] }>;
    verify(vk: object, publicSignals: string[], proof: object): Promise<boolean>;
  };
}
