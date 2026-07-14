/**
 * String casing utilities for code generation
 */

/**
 * Convert string to PascalCase
 * @example "supplier complaint" -> "SupplierComplaint"
 * @example "create-order" -> "CreateOrder"
 */
export function toPascalCase(str: string): string {
  return str
    .replace(/[^a-zA-Z0-9]+(.)/g, (_, char) => char.toUpperCase())
    .replace(/^[a-z]/, (char) => char.toUpperCase());
}

/**
 * Convert string to camelCase
 * @example "SupplierComplaint" -> "supplierComplaint"
 * @example "create-order" -> "createOrder"
 */
export function toCamelCase(str: string): string {
  const pascal = toPascalCase(str);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/**
 * Convert string to snake_case
 * @example "SupplierComplaint" -> "supplier_complaint"
 */
export function toSnakeCase(str: string): string {
  return str
    .replace(/([A-Z])/g, '_$1')
    .toLowerCase()
    .replace(/^_/, '');
}

/**
 * Convert string to kebab-case (slug)
 * @example "Supplier Complaint" -> "supplier-complaint"
 */
export function toSlug(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Convert string to SCREAMING_SNAKE_CASE
 * @example "SupplierComplaint" -> "SUPPLIER_COMPLAINT"
 */
export function toScreamingSnakeCase(str: string): string {
  return toSnakeCase(str).toUpperCase();
}

/**
 * Pluralize word (simple English rules)
 * @example "complaint" -> "complaints"
 * @example "status" -> "statuses"
 */
export function pluralize(word: string): string {
  if (word.endsWith('s') || word.endsWith('x') || word.endsWith('ch') || word.endsWith('sh')) {
    return word + 'es';
  }
  if (word.endsWith('y')) {
    return word.slice(0, -1) + 'ies';
  }
  return word + 's';
}

/**
 * Singularize word (simple English rules)
 * @example "complaints" -> "complaint"
 * @example "statuses" -> "status"
 */
export function singularize(word: string): string {
  if (word.endsWith('ies')) {
    return word.slice(0, -3) + 'y';
  }
  if (word.endsWith('es')) {
    return word.slice(0, -2);
  }
  if (word.endsWith('s')) {
    return word.slice(0, -1);
  }
  return word;
}
