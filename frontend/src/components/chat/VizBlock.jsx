import React from "react";
import { TicketCard } from "../../ds";

/** Renders a structured viz block emitted by an agent. Unknown types are
 * ignored so new block types stay additive. */
export function VizBlock({ block }) {
  if (block?.type === "ticket_card") {
    const d = block.data || {};
    return (
      <TicketCard
        id={d.id}
        title={d.title}
        description={d.description}
        status={d.status}
        budget={d.budget}
        files={d.files || []}
        style={{ maxWidth: 420 }}
      />
    );
  }
  return null;
}
