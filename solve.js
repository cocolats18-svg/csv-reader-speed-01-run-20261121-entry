// Fast drop-in for csv-reader 1.0.0: run(input) returns exactly csv-reader's answer
// {columns, rows, errors} for the input {text, header}, reading the text once,
// left to right. Written from the reference's stated policy, not copied from it.
//
// How it stays fast: a record with no quote on its line is taken in one line
// slice and split on commas; only a record that holds a quote, or a stray CR,
// goes through the field-by-field scanner. That scanner jumps with indexOf
// instead of stepping a character at a time, keeps the line's end in hand so
// an unquoted field needs one indexOf, and slices fields out instead of
// building them up. No regex, no per-character loop on the hot path.

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (len > 0 && text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it takes (null: the header).
  let recordLine = 1;
  let recordRow = null;

  // The end of the line the record is on: the first LF at or after the record's
  // start (or len, with hasNL false, when there is none). A field ends at the
  // first comma before it, or at it. It is recomputed lazily in unquoted() when
  // a quoted field has run past it onto a later line.
  let le = 0;
  let hasNL = false;

  // One field's reading, set by unquoted() and quoted(): its value, how it ended
  // (0 comma, 1 line break, 2 end of text) and how many characters were added.
  let fval = '';
  let fend = 0;
  let fadded = 0;

  function pushErr(code) {
    errors.push({ code, line: recordLine, row: recordRow });
  }

  // `s` holds at least one CR, each a stray one: drop them, one stray_cr error each.
  function stripCR(s) {
    let out = '';
    let from = 0;
    for (;;) {
      const r = s.indexOf('\r', from);
      if (r === -1) {
        out += s.slice(from);
        return out;
      }
      out += s.slice(from, r);
      pushErr('stray_cr');
      from = r + 1;
    }
  }

  // Reads an unquoted field starting at pos, onto the initial value `init`.
  // It ends at the first comma before the line end, or at the line end: a CR
  // not followed by LF is dropped (stray_cr); a CRLF ends the field as one
  // line break; `fadded` counts only the characters added after `init`.
  function unquoted(init) {
    if (pos > le) {
      const e = text.indexOf('\n', pos);
      le = e === -1 ? len : e;
      hasNL = e !== -1;
    }
    let v = init;
    let added = 0;
    const ci = text.indexOf(',', pos);
    if (ci !== -1 && ci < le) {
      const s = text.slice(pos, ci);
      if (s.indexOf('\r') === -1) {
        v += s;
        added += s.length;
      } else {
        const c = stripCR(s);
        v += c;
        added += c.length;
      }
      pos = ci + 1;
      fval = v;
      fend = 0;
      fadded = added;
      return;
    }
    if (hasNL) {
      // The field ends at the line break: a CR right before the LF is its CRLF.
      if (le > pos && text.charCodeAt(le - 1) === 13) {
        const s = text.slice(pos, le - 1);
        if (s.indexOf('\r') === -1) {
          v += s;
          added += s.length;
        } else {
          const c = stripCR(s);
          v += c;
          added += c.length;
        }
        pos = le + 1;
        line += 1;
        fval = v;
        fend = 1;
        fadded = added;
        return;
      }
      const s = text.slice(pos, le);
      if (s.indexOf('\r') === -1) {
        v += s;
        added += s.length;
      } else {
        const c = stripCR(s);
        v += c;
        added += c.length;
      }
      pos = le + 1;
      line += 1;
      fval = v;
      fend = 1;
      fadded = added;
      return;
    }
    const s = text.slice(pos);
    if (s.indexOf('\r') === -1) {
      v += s;
      added += s.length;
    } else {
      const c = stripCR(s);
      v += c;
      added += c.length;
    }
    pos = len;
    fval = v;
    fend = 2;
    fadded = added;
  }

  // A stretch of a quoted field, [a, b): each CRLF or lone CR inside it is one
  // LF, and each counts one line. Without a line break it is the slice as is.
  function seg(a, b) {
    const s = text.slice(a, b);
    if (s.indexOf('\n') === -1 && s.indexOf('\r') === -1) return s;
    let out = '';
    let i = 0;
    const n = s.length;
    while (i < n) {
      const ni = s.indexOf('\n', i);
      const ri = s.indexOf('\r', i);
      if (ni === -1 && ri === -1) {
        out += s.slice(i);
        break;
      }
      let j;
      let isCR;
      if (ri === -1 || (ni !== -1 && ni < ri)) {
        j = ni;
        isCR = false;
      } else {
        j = ri;
        isCR = true;
      }
      out += s.slice(i, j);
      out += '\n';
      line += 1;
      i = j + 1;
      if (isCR && s.charCodeAt(i) === 10) i += 1;
    }
    return out;
  }

  // Reads a quoted field whose opening quote is at pos.
  function quoted() {
    const open = pos;
    const openLine = line;
    let v = '';
    let p = pos + 1;
    for (;;) {
      const q = text.indexOf('"', p);
      if (q === -1) {
        // The quote never closes: it is a literal character, and the text after
        // it is read again as unquoted. The failed scan's line count is undone.
        line = openLine;
        pushErr('unterminated_quote');
        pos = open + 1;
        unquoted('"');
        return;
      }
      if (text.charCodeAt(q + 1) === 34) {
        // A doubled quote is one quote, and the field runs on.
        v += seg(p, q);
        v += '"';
        p = q + 2;
        continue;
      }
      // The closing quote.
      v += seg(p, q);
      pos = q + 1;
      if (pos >= len) {
        fval = v;
        fend = 2;
        fadded = 0;
        return;
      }
      const c = text.charCodeAt(pos);
      if (c === 44) {
        pos += 1;
        fval = v;
        fend = 0;
        fadded = 0;
        return;
      }
      if (c === 10) {
        pos += 1;
        line += 1;
        fval = v;
        fend = 1;
        fadded = 0;
        return;
      }
      if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
        fval = v;
        fend = 1;
        fadded = 0;
        return;
      }
      // What follows the closing quote is appended as it stands, up to the next
      // comma or line break.
      unquoted(v);
      if (fadded > 0) pushErr('quote_junk');
      return;
    }
  }

  // A record's fields, read whole: the header, a padded or cut row, or nothing
  // for a line left with no characters.
  function finish(fields, quotedLast) {
    if (fields.length === 1 && fields[0] === '' && !quotedLast) return;
    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      return;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;

    // The fast path: no quote opens on this line, so no field on it is quoted
    // and the record ends at its line break. A line holding a stray CR, or a
    // quote, falls through to the field-by-field reader below.
    const lineEnd = text.indexOf('\n', pos);
    le = lineEnd === -1 ? len : lineEnd;
    hasNL = lineEnd !== -1;
    const lineText = text.slice(pos, le);
    if (lineText.indexOf('"') === -1) {
      let fields = null;
      if (lineText.charCodeAt(lineText.length - 1) === 13) {
        if (hasNL && lineText.indexOf('\r') === lineText.length - 1) {
          // CRLF line: the trailing CR is the line break, not a field character.
          fields = lineText.slice(0, -1).split(',');
          pos = le + 1;
          line += 1;
        }
      } else if (lineText.indexOf('\r') === -1) {
        fields = lineText.split(',');
        pos = hasNL ? le + 1 : len;
        if (hasNL) line += 1;
      }
      if (fields !== null) {
        finish(fields, false);
        continue;
      }
    }

    // Field by field: the record holds a quote or a stray CR.
    const fields = [];
    let quotedLast = false;
    do {
      quotedLast = text.charCodeAt(pos) === 34;
      if (quotedLast) quoted();
      else unquoted('');
      fields.push(fval);
    } while (fend === 0);
    finish(fields, quotedLast);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
