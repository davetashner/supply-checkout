export interface PublicSafetyRule {
  readonly name: string;
  readonly re: RegExp;
  readonly allow?: (match: string) => boolean;
}
export const RULES: readonly PublicSafetyRule[];
export function publicSafetyFindings(text: string): { name: string }[];
