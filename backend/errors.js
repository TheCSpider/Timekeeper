/**
 * Convert a caught error into a user-facing message.
 * PostgreSQL error codes: https://www.postgresql.org/docs/current/errcodes-appendix.html
 */
function userMessage(err) {
  switch (err.code) {
    case '23505': // unique_violation
      return `Duplicate value — ${err.detail || 'a record with that value already exists.'}`;
    case '23503': // foreign_key_violation
      return `Reference error — ${err.detail || 'a related record does not exist.'}`;
    case '23514': // check_violation
      return `Invalid value — ${err.detail || 'the value does not meet the allowed options.'}`;
    case '23502': // not_null_violation
      return `Missing required field: "${err.column || 'unknown'}".`;
    case '42703': // undefined_column
      return `Database column not found: ${err.message}. ` +
             'If you updated the server, restart the container to apply automatic migrations.';
    case '42P01': // undefined_table
      return `Database table not found: ${err.message}. Check your database setup.`;
    case '22P02': // invalid_text_representation (e.g. bad integer cast)
      return `Invalid data format — ${err.message}.`;
    default:
      return err.message || 'An unexpected error occurred.';
  }
}

/**
 * Send a structured error response and log the full error server-side.
 * @param {Response} res - Express response object
 * @param {Error}    err - Caught error
 * @param {string}   context - Short label for the log (e.g. 'PUT /chores/:id')
 */
function sendError(res, err, context = '') {
  const label = context ? `[${context}]` : '';
  console.error(`${label} Error:`, err);
  const status = err.status || 500;
  res.status(status).json({ error: userMessage(err) });
}

module.exports = { userMessage, sendError };
