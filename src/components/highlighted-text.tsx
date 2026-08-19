"use client";

import { splitHighlighted } from "@/lib/domain/search";

/**
 * Render matched ranges as marked spans.
 *
 * Uses the domain layer's segment split rather than `dangerouslySetInnerHTML`,
 * so user content can never inject markup. Shared by the command palette and
 * the full search page, which must highlight identically — they render the
 * same ranges from the same endpoint.
 */
export function Highlighted({
  highlights,
  text,
}: {
  highlights: Array<{ start: number; end: number }>;
  text: string;
}) {
  const parts = splitHighlighted(text, highlights);

  return (
    <>
      {parts.map((part, index) =>
        part.match ? (
          <mark
            className="rounded bg-teal-300/20 px-0.5 text-teal-100"
            key={`${index}-${part.text}`}
          >
            {part.text}
          </mark>
        ) : (
          <span key={`${index}-${part.text}`}>{part.text}</span>
        ),
      )}
    </>
  );
}
