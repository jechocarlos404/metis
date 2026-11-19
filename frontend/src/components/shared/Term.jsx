import React from "react";
import { plain } from "../../lib/words.js";

/**
 * A plain word with its raw API value one hover away.
 *   <Term dict={EDGE} value="DEPENDS_ON" />  → "needs" (title: DEPENDS_ON)
 * The raw value stays greppable in the DOM (data-raw) for screenshots and
 * logs, without being the thing a person reads.
 */
export function Term({ dict, value, style }) {
  if (value == null) return null;
  const word = plain(dict, value);
  return (
    <span title={word === String(value) ? undefined : String(value)} data-raw={value} style={style}>
      {word}
    </span>
  );
}
