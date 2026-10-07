import { formatPrice } from "./format.js";

export function totalLine(cents) {
  return `Total: ${formatPrice(cents)}`;
}
