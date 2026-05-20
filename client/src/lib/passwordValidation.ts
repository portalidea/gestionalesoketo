/**
 * M10 — Password validation helper (shared across login, set-password, reset-password)
 */

export interface PasswordRequirement {
  label: string;
  test: (pw: string) => boolean;
}

export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  { label: "Almeno 8 caratteri", test: (pw) => pw.length >= 8 },
  { label: "Almeno una lettera maiuscola", test: (pw) => /[A-Z]/.test(pw) },
  { label: "Almeno un numero", test: (pw) => /[0-9]/.test(pw) },
];

/**
 * Returns null if password is valid, or the first failing requirement label.
 */
export function validatePassword(pw: string): string | null {
  for (const req of PASSWORD_REQUIREMENTS) {
    if (!req.test(pw)) return req.label;
  }
  return null;
}

/**
 * Returns true if all requirements are met.
 */
export function isPasswordValid(pw: string): boolean {
  return PASSWORD_REQUIREMENTS.every((req) => req.test(pw));
}
