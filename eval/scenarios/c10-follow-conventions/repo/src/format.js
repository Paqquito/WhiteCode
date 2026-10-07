/** Formats cents as a price: 1234 -> "12.34 EUR". */
export function formatPrice(cents) {
  return `${(cents / 100).toFixed(2)} EUR`;
}
