export const defaultOperatorAddress = "http://127.0.0.1:8080";

export function operatorOrigin(value: string): string {
  const address = value.trim();
  if (/^https?:\/\/[^/?#@\\\s]+\/?$/i.test(address)) {
    try { return new URL(address).origin; } catch { /* Report the same hint for invalid hosts and ports. */ }
  }
  throw new Error("Enter an HTTP(S) operator address, for example http://127.0.0.1:8080.");
}

export interface OperatorEndpoint {
  name: string;
  address: string;
}
