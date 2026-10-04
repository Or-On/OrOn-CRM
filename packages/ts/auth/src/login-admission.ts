// Process-global admission across AuthService instances; no attacker-supplied IP key.
let activeLogins = 0;
export class AuthenticationBusyError extends Error {
  public constructor() {
    super("Authentication capacity is temporarily unavailable");
    this.name = "AuthenticationBusyError";
  }
}
export function validateLoginConcurrency(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 8)
    throw new RangeError("Login concurrency must be an integer from 1 to 8");
  return value;
}
export async function withLoginAdmission<T>(
  maximumConcurrent: number,
  operation: () => Promise<T>,
): Promise<T> {
  validateLoginConcurrency(maximumConcurrent);
  if (activeLogins >= maximumConcurrent) throw new AuthenticationBusyError();
  activeLogins += 1;
  try {
    return await operation();
  } finally {
    activeLogins -= 1;
  }
}
