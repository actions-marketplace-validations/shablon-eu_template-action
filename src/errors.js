/**
 * An error tied to a specific file (and optionally a line), so it can be
 * reported as a GitHub annotation pointing at the offending source.
 */
export class TemplateError extends Error {
  /**
   * @param {string} message
   * @param {{ file?: string, line?: number, column?: number, slug?: string }} [location]
   */
  constructor(message, location = {}) {
    super(message);
    this.name = 'TemplateError';
    this.file = location.file;
    this.line = location.line;
    this.column = location.column;
    this.slug = location.slug;
  }
}
