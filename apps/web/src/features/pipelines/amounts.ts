/** Decimal strings stay exact; summing through Number loses money at large values. */
export function sumAmounts(values: readonly string[]): string {
  const parsed = values.map((value) => {
    const match = /^(-?)(\d+)(?:\.(\d+))?$/u.exec(value);
    if (!match) throw new TypeError("Invalid decimal amount");
    return {
      negative: match[1] === "-",
      whole: match[2] ?? "0",
      fraction: match[3] ?? "",
    };
  });
  const scale = Math.max(0, ...parsed.map((value) => value.fraction.length));
  const total = parsed.reduce(
    (sum, value) =>
      sum +
      (value.negative ? -1n : 1n) *
        BigInt(value.whole + value.fraction.padEnd(scale, "0")),
    0n,
  );
  const digits = (total < 0n ? -total : total)
    .toString()
    .padStart(scale + 1, "0");
  return (
    (total < 0n ? "-" : "") +
    (scale ? digits.slice(0, -scale) + "." + digits.slice(-scale) : digits)
  );
}

export function formatAmount(
  value: string,
  currency: string,
  locale: string,
): string {
  // ECMA-402 accepts exact numeric strings; TS's callable declaration still omits them.
  const formatter = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  });
  const result: unknown = Reflect.apply(
    formatter.format.bind(formatter),
    undefined,
    [value],
  );
  if (typeof result !== "string")
    throw new TypeError("Amount formatting failed");
  return result;
}
