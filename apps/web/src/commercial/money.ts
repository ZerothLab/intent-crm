import { t } from '../i18n';
/** Parse yuan input without floating-point multiplication or silent rounding. */
export function amountToCents(value: string): number {
    const input = value.trim();
    if (!/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(input))
        throw new Error(t("Enter an amount in CNY with up to two decimal places, without commas or scientific notation."));
    const [whole, fraction = ''] = input.split('.');
    const result = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
    if (!Number.isSafeInteger(result) || result <= 0 || result > 1000000000000)
        throw new Error(t("The amount must be greater than zero and no more than CNY 10 billion."));
    return result;
}
